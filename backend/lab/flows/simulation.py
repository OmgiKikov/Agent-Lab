"""Runs: the deck's scenarios played against the agent by the synthetic customer, each conversation judged when it
ends, and a run judged again.

A run is made by a task and takes its id; the run's record is what the task continues from after a restart. A
conversation is written when it ends, before it is judged, and again with its verdict or its error. A task taken up
after a restart judges the conversations that ended and plays again, from the start, the ones that did not: the agent
keeps what it was told under the conversation's id, so going on with it, or saying its last line again, would tell it a
line twice (replayed). A stop ends the run as it stands. Both judges of a played conversation see one prepared set of
evidence (evidence). A run judged again takes the new verdicts together, at the end, keeping each as a step of its task
so a stopped or failed pass continues where it was: until then the run stays as it was.
"""

import asyncio
import time
import uuid
from collections import Counter
from collections.abc import Callable
from copy import deepcopy

from .. import agents, models, storage
from ..agents import knowledge, world
from ..domain import checks, personas
from ..domain import world as scenario_world
from ..domain.transcript import for_judge, tool_calls, with_buttons
from ..domain.verdicts import with_asked
from ..roles import customer, judge
from . import Progress, agent_context, connection, error_text, provenance, same_work, scenarios

MAX_AGENT_TURNS = 3
PENDING_VERSION = '…'  # a run's agent version until the agent is reached
PARALLEL = 4
NO_REPLIES = 'Агент не ответил ни в одном разговоре'
# What a re-judge changes in a conversation.
JUDGED = ('status', 'rules', 'model', 'judgeVersion', 'second', 'error', 'criteria')


async def customer_says(card: dict, conversation: list[dict], details: str = '', persona: str | None = None) -> str:
    transcript = '\n\n'.join(
        ('КЛИЕНТ (это ты): ' if message['role'] == 'customer' else 'АГЕНТ: ') + with_buttons(message)
        for message in conversation
    )
    answer = await customer.reply(card['situation'], transcript, details, personas.style(persona))
    return answer.value


async def prepare_openings(chosen: list[dict], persona_ids: list[str], progress: Progress) -> None:
    """Rewrite once per scenario/customer type, so later runs remain comparable."""
    missing = [
        (card, key)
        for card in chosen
        for key in persona_ids
        if key != personas.DEFAULT and not (card.get('openings') or {}).get(key)
    ]
    if not missing:
        return
    progress(done=0, total=len(missing), message='Переписываем первые реплики под типы клиентов')

    async def rewrite(card: dict, key: str) -> None:
        answer = await customer.opening(card['opening'], personas.style(key))
        card.setdefault('openings', {})[key] = answer.value

    async with asyncio.TaskGroup() as group:
        for card, key in missing:
            group.create_task(rewrite(card, key))
    scenarios.remember_openings({card['id']: card['openings'] for card, _ in missing})


def opening(card: dict, persona: str) -> str:
    return card['opening'] if persona == personas.DEFAULT else card['openings'][persona]


async def play(card: dict, agent: agents.HttpAgent, record: dict, item: dict, changed: Callable[[], None]) -> None:
    """One conversation of the scenario with the agent, up to MAX_AGENT_TURNS replies, then judged. A conversation the
    agent or the model broke keeps its turns and says why."""
    conversation = item['conversation']
    shapes = world.templates(connection.repo()) if agent.mocked else None
    test_data = scenario_world.overrides(card.get('world'), shapes) if agent.mocked else {}
    details = scenario_world.customer_profile(card.get('world')) if test_data else record.get('customer', '')
    # Whether the conversation ran to its end: only such a conversation may be judged again (ended).
    item.update(world=bool(test_data), ended=False)
    persona = item.get('persona') or personas.DEFAULT
    line, from_log = opening(card, persona), persona == personas.DEFAULT
    try:
        for turn in range(1, MAX_AGENT_TURNS + 1):
            conversation.append(
                {'role': 'customer', 'text': line, 'fromLog': from_log, 'rewritten': turn == 1 and not from_log}
            )
            item['stage'] = f'ход {turn}: агент отвечает'
            changed()
            reply = await agent.say(item['conversationId'], line, test_data)
            conversation.append({'role': 'agent', **reply})
            changed()
            if not reply['text']:
                raise agents.AgentError(f'Агент не прислал текст ответа (статус {reply["status"]}).')
            if not reply['ok'] or turn == MAX_AGENT_TURNS:
                break
            item['stage'] = f'ход {turn + 1}: клиент пишет'
            changed()
            line, from_log = await customer_says(card, conversation, details, persona), False
            if customer.END in line or not line:
                break
        item['ended'] = True
    except (agents.AgentError, models.ModelError) as error:
        item.update(status='UNMEASURED', error=str(error), stage='')
        changed()
        return
    await judged(card, item, changed)


async def judged(card: dict, item: dict, changed: Callable[[], None]) -> None:
    """A conversation that ran to its end, written as it is (a restart judges it, never plays it again), then judged; a
    verdict the model could not give leaves it unmeasured, saying why."""
    item['stage'] = 'модель оценивает'
    changed()
    try:
        await evaluate(card, item)
    except models.ModelError as error:
        item.update(status='UNMEASURED', error=str(error))
    item['stage'] = ''
    changed()


def replayed(item: dict) -> dict:
    """A conversation a process before this one left unfinished, to be played again from its start as a new
    conversation with the agent (restarts counts how many times)."""
    return item | {
        'conversationId': str(uuid.uuid4()),
        'conversation': [],
        'stage': 'в очереди',
        'error': None,
        'ended': False,
        'restarts': item.get('restarts', 0) + 1,
    }


def new_run_id() -> str:
    """A run's id: when it started, then a few random letters."""
    return f'{time.strftime("%Y%m%d-%H%M%S")}-{uuid.uuid4().hex[:8]}'


def new_run(
    key: str, config: dict, label: str, repeats: int, persona_ids: list[str], run_id: str | None = None
) -> dict:
    return {
        'id': run_id or new_run_id(),
        'target': key,
        'targetName': config['name'],
        'version': PENDING_VERSION,
        'label': label,
        'customer': config.get('customer', ''),
        'startedAt': storage.now(),
        'finishedAt': None,
        'model': models.main_model(),
        'status': 'running',
        'items': [],
        'metric': None,
        'error': None,
        'repeats': repeats,
        'personas': persona_ids,
    }


def new_item(card: dict, persona: str, attempt: int) -> dict:
    return {
        'cardId': card['id'],
        'persona': persona,
        'name': card['name'],
        'topic': card['topic'],
        'attempt': attempt,
        'origin': card['origin'],
        'situation': card['situation'],
        'criteria': deepcopy(card['criteria']),
        'status': 'RUNNING',
        'stage': 'в очереди',
        'conversationId': str(uuid.uuid4()),
        'conversation': [],
        'rules': [],
        'error': None,
    }


async def run(
    key: str,
    card_ids: list[str] | None = None,
    label: str = '',
    progress: Progress = lambda **_: None,
    repeats: int = 1,
    persona_ids: list[str] | None = None,
) -> dict:
    """The deck's scenarios played against the agent by `key`, each conversation judged, the run saved as it goes. A
    task taken up after a restart continues its run (the task's id is the run's): see the module."""
    task_id = storage.tasks.current_id()
    record = storage.runs.get(task_id) if task_id else None
    if record is None:
        record, chosen = begun(key, card_ids, label, repeats, persona_ids, task_id)
    elif record['status'] != 'running':
        return record  # it ended before the process that made it did: a stop or a failure stands
    else:
        try:
            chosen = continued(record)
        except RuntimeError as error:
            record.update(status='failed', error=str(error))
            finish(record)
            raise
    by_id = {card['id']: card for card in chosen}
    plan = [by_id[item['cardId']] for item in record['items']]
    config = connection.ways()[key]
    # The conversations written as ended already: a restart found them so, or play() wrote them so (changed).
    ended_before = {i for i, item in enumerate(record['items']) if item['status'] == 'RUNNING' and item.get('ended')}

    def changed(index: int) -> None:
        """A conversation is written when it ends (before it is judged) and when it has its verdict or its error; its
        turns until then stay in memory. A write rereads and rewrites the whole run, on the event loop that stop also
        needs, so not one per turn."""
        item = record['items'][index]
        if item['status'] != 'RUNNING' or (item.get('ended') and index not in ended_before):
            if item['status'] == 'RUNNING':
                ended_before.add(index)
            storage.runs.update_item(record['id'], index, item)
            # A finished part of the task: a restart that finds new ones knows the run goes on (storage.tasks.resume).
            storage.tasks.keep(f'conversation:{index}:{"ended" if item["status"] == "RUNNING" else "measured"}', True)
        done = sum(item['status'] != 'RUNNING' for item in record['items'])
        progress(run=record['id'], done=done, total=len(plan), message=f'Играем сценарии · {record["targetName"]}')

    done = sum(item['status'] != 'RUNNING' for item in record['items'])
    progress(run=record['id'], done=done, total=len(plan), message=f'Подключаемся к агенту · {config["name"]}')
    # The customer's and the judges' calls are about this run in the journal.
    with models.about(f'run:{record["id"]}'):
        try:
            await prepare_openings(chosen, record['personas'], progress)
            async with agents.session(connection.connect(key)) as agent:
                same_agent(record, agent.version)
                record['version'] = agent.version
                storage.runs.update(record['id'], version=agent.version)
                await play_all(record, plan, agent, changed)
            # A run the agent answered in no conversation has nothing to judge, now or later: it failed, and says why.
            silent = unanswered(record['items'])
            record.update(status='failed' if silent else 'done', error=silent)
        except asyncio.CancelledError:
            if not storage.tasks.closing():
                record.update(status='stopped', error='Прогон остановлен')
            raise
        except Exception as error:
            record.update(status='failed', error=error_text(error))
        finally:
            # The Lab closing leaves the run as it is, for the next process to continue (storage.tasks.closing).
            if not storage.tasks.closing():
                finish(record)
    return storage.runs.get(record['id'])


async def play_all(record: dict, plan: list[dict], agent: agents.HttpAgent, changed: Callable[[int], None]) -> None:
    """The run's conversations not measured yet, a few at a time: one that ended is judged, the others are played."""
    gate = asyncio.Semaphore(PARALLEL)

    async def one(card: dict, index: int) -> None:
        item = record['items'][index]
        async with gate:
            if item.get('ended'):
                await judged(card, item, lambda: changed(index))
            else:
                await play(card, agent, record, item, lambda: changed(index))

    async with asyncio.TaskGroup() as group:
        for index, card in enumerate(plan):
            if record['items'][index]['status'] == 'RUNNING':
                group.create_task(one(card, index))


def begun(
    key: str, card_ids: list[str] | None, label: str, repeats: int, persona_ids: list[str] | None, run_id: str | None
) -> tuple[dict, list[dict]]:
    """A new run of the chosen scenarios, saved before the first conversation, and the scenarios."""
    chosen = [card for card in scenarios.deck() if not card_ids or card['id'] in card_ids]
    if not chosen:
        raise RuntimeError('Нет сценариев для прогона. Сначала соберите сценарии.')
    persona_ids = [p for p in personas.PERSONAS if p in (persona_ids or [personas.DEFAULT])] or [personas.DEFAULT]
    config = connection.ways()[key]
    record = new_run(key, config, label, repeats, persona_ids, run_id)
    plan = [(card, persona, attempt) for attempt in range(1, repeats + 1) for persona in persona_ids for card in chosen]
    record['items'] = [new_item(card, persona, attempt) for card, persona, attempt in plan]
    # The run is measured by the criteria of the check its deck was built from, and remembers it.
    record['check'] = scenarios.check() or checks.of_run(record)
    record.update(provenance.snapshot(record['check']))
    storage.runs.create(record)
    return record, chosen


def continued(record: dict) -> list[dict]:
    """A run a process before this one left running, to be continued, and its scenarios: the conversations that ended
    are judged, the unfinished ones played again (replayed)."""
    by_id = {card['id']: card for card in scenarios.deck()}
    missing = sorted({item['cardId'] for item in record['items']} - by_id.keys())
    if missing:
        raise RuntimeError('Сценарии прогона изменились, пока Lab перезапускался. Запустите прогон заново.')
    again = {}
    for index, item in enumerate(record['items']):
        item.setdefault('ended', False)
        if item['status'] == 'RUNNING' and not item['ended']:
            record['items'][index] = again[index] = replayed(item)
    storage.runs.update_items(record['id'], again)
    return [by_id[card_id] for card_id in dict.fromkeys(item['cardId'] for item in record['items'])]


def same_agent(record: dict, version: str) -> None:
    """A run continued after a restart goes on only with the agent it began with: one run must not mix two versions of
    the agent. A stand that names no version cannot be told apart, and goes on."""
    unknown = {PENDING_VERSION, agents.UNKNOWN_VERSION, '', None}
    if record['version'] not in unknown and version not in unknown and version != record['version']:
        raise RuntimeError(
            f'Агент на стенде обновился, пока Lab перезапускался (было {record["version"]}, стало {version}): '
            'в одном прогоне нельзя смешивать версии. Запустите прогон заново.'
        )


def finish(record: dict) -> None:
    """What the stop or the failure cut short, with the final status, in one write: not one per conversation."""
    cut = {}
    for index, item in enumerate(record['items']):
        if item['status'] == 'RUNNING':
            item.update(status='UNMEASURED', stage='', error=record['error'])
            cut[index] = item
    storage.runs.update_items(
        record['id'],
        cut,
        status=record['status'],
        error=record['error'],
        finishedAt=storage.now(),
        model=models.models_used(record['items']),
    )


def ended(item: dict) -> bool:
    """The conversation ran to its end, so it can be judged again. One cut short (the agent failed, the customer's
    model failed, the run was stopped) keeps its status and its error: judging half a conversation would count it.
    A record from before play() marked this is read from its last message: a whole conversation ends on the agent's
    reply, one the agent broke on the customer's turn."""
    if 'ended' in item:
        return bool(item['ended'])
    last = (item.get('conversation') or [{}])[-1]
    return last.get('role') == 'agent' and bool(last.get('text'))


def unanswered(items: list[dict]) -> str | None:
    """Why a run has nothing to judge: no conversation ran to its end (ended, as rejudge reads it), with what most of
    them broke on («Нет связи с агентом (ConnectError).»). None when the agent answered in some."""
    if not items or any(ended(item) for item in items):
        return None
    reasons = Counter(item['error'] for item in items if item.get('error'))
    return f'{NO_REPLIES}. {reasons.most_common(1)[0][0]}' if reasons else f'{NO_REPLIES}.'


async def rejudge(record: dict, progress: Progress = lambda **_: None) -> dict:
    """Rejudge the recorded conversations that ran to their end against the criteria frozen when they were played.

    The new verdicts replace the old ones together, after the whole pass: a stopped or failed pass leaves the run as
    it was, never half re-judged under a final status. Each new verdict is kept as a step of the task meanwhile, so the
    same pass started again (rejudge_fingerprint) judges only the rest. A pass in which the model gave no verdict on
    some conversation failed: an outage is not a verdict, and writing one would take the verdicts that stood and the
    answers people gave on them (storage.runs.update_items)."""
    items = [(index, item) for index, item in enumerate(record['items']) if ended(item)]
    if not items:
        raise RuntimeError('В прогоне нет записанных ответов агента: ни один разговор не дошёл до конца.')
    legacy = [(index, item) for index, item in items if not isinstance(item.get('criteria'), list)]
    if legacy:
        by_id = {card['id']: card for card in scenarios.deck()}
        for _, item in legacy:
            card = by_id.get(item['cardId'])
            if card is None:
                raise RuntimeError(
                    'В старом прогоне не сохранены критерии, а его сценария больше нет. '
                    'Сыграйте текущие сценарии заново.'
                )
            item['criteria'] = deepcopy(card['criteria'])
    kept = storage.tasks.steps()
    done, failed = 0, Counter()

    async def one(index: int, item: dict) -> None:
        nonlocal done
        found = kept.get(f'item:{index}')
        if found is None:
            try:
                await evaluate(item, item)
                found = storage.tasks.keep(
                    f'item:{index}', {key: item[key] for key in JUDGED if key != 'error' and key in item}
                )
            except models.ModelError as error:
                failed[str(error)] += 1
        if found is not None:
            item.update(found, error=None)
        done += 1
        progress(done=done, total=len(items), message='Оцениваем разговоры заново')

    with models.about(f'run:{record["id"]}'):
        async with asyncio.TaskGroup() as group:
            for index, item in items:
                group.create_task(one(index, item))
    if failed:
        reason = failed.most_common(1)[0][0]
        raise models.ModelError(
            f'Модель не оценила разговоры прогона: {failed.total()}\u00a0из\u00a0{len(items)}. '
            f'Прогон остался прежним. {reason}'
        )
    verdicts = {index: {key: item[key] for key in JUDGED if key in item} for index, item in items}
    return storage.runs.update_items(
        record['id'], verdicts, rejudgedAt=storage.now(), model=models.models_used(record['items'])
    )


def rejudge_fingerprint(given: dict) -> str:
    """The same pass judging a run again (work.KINDS): the same run, by the same judges."""
    return same_work(rejudge=given['runId'], judges=[models.endpoints().main, models.second_judge()])


async def evidence(card: dict, conversation: list[dict]) -> judge.Evidence:
    """What both judges see of a played conversation, with the knowledge articles the agent read in it."""
    shown = [{'role': m['role'].upper(), 'text': for_judge(m)} for m in conversation]
    replies = [message for message in conversation if message['role'] == 'agent']
    # The agent's words and its buttons' labels: the agent wrote both, the Lab's «[Кнопки: …]» around them it did not.
    agent_text = '\n'.join(line for reply in replies for line in (reply['text'], *(reply.get('options') or [])))
    calls = '\n'.join(call for reply in replies for call in tool_calls(reply))
    retrieved = await asyncio.to_thread(knowledge.retrieved, connection.repo(), conversation)
    if agent_context.current()['idpIndex']:
        fetched, warning = await agent_context.knowledge(conversation[0]['text'] if conversation else '')
        retrieved = [*retrieved, *fetched]
    else:
        warning = None
    payload = {
        'availableTools': agent_context.current()['tools'],
        'contextWarning': warning,
        'expectations': card['criteria'],
        'conversation': shown,
        'toolCallsObserved': bool(calls),
        'knowledge': retrieved,
    }
    return judge.Evidence(card['criteria'], payload, agent_text, calls, bool(retrieved))


async def run_verdict(card: dict, conversation: list[dict], model: models.Endpoint | None = None) -> judge.Verdict:
    """A conversation the synthetic customer just had with the agent, against the card's criteria."""
    return await judge.run_verdict(await evidence(card, conversation), model)


async def evaluate(card: dict, item: dict) -> None:
    """Judge a run's conversation in place: rows, each quoted one with the customer's words its reply answered
    (verdicts.with_asked), verdict and the second judge's verdict."""
    prepared = await evidence(card, item['conversation'])
    if agent_context.current()['idpIndex']:
        item.update(knowledge=prepared.payload['knowledge'], contextError=prepared.payload['contextWarning'])
    try:
        async with asyncio.TaskGroup() as tasks:
            primary = tasks.create_task(judge.run_verdict(prepared))
            secondary = tasks.create_task(judge.second_opinion(judge.run_verdict, prepared))
    except* models.ModelError as errors:
        raise models.ModelError(str(errors.exceptions[0])) from errors
    result = primary.result()
    rows = with_asked(result.rows, prepared.payload['conversation'])
    item.update(rules=rows, status=result.status, model=result.model, judgeVersion=result.version)
    item['second'] = secondary.result()
