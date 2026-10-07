"""Runs: the deck's scenarios played against the agent by the synthetic customer, each conversation judged when it
ends, and a run judged again.

A conversation's turns stay in memory, in the job's progress; it is written once, when it ends with a verdict or an
error. Both judges of a played conversation see one prepared set of evidence (evidence). A run judged again takes the
new verdicts together, at the end: a stopped or failed pass leaves the run as it was.
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
from ..roles import customer, judge
from . import Progress, connection, error_text, scenarios

MAX_AGENT_TURNS = 3  # the budget of a conversation: reaching it cuts the conversation short, it is no outcome
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
        for key in personas.plays(card, persona_ids)
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


def customer_details(
    card: dict, agent: agents.HttpAgent, shapes: dict | None, test_data: dict, conversation_id: str
) -> dict:
    """What the customer can say of its organization and terminals: the client the agent's bank holds in this
    conversation, as far as the card says the customer knows it (identifiers). The bank is the scenario's world when
    the mocks took it, the stand's own fixtures when they did not, and on the IFT stand the organization of the
    conversation's EPK as the settings describe it. {from: world | fixtures | epk, epk, known, text}; known is false
    when the bank's client is unknown here: the customer is then told it has no details at hand, never made-up ones."""
    if test_data:
        found, client = {'from': 'world'}, card.get('world')
    elif agent.mocked:
        found, client = {'from': 'fixtures'}, scenario_world.fixture_client(shapes)
    else:
        epk, described = agent.client(conversation_id)
        found, client = {'from': 'epk', 'epk': epk}, scenario_world.epk_client(described)
    text = scenario_world.customer_profile(client, card.get('identifiers'))
    return found | {'known': bool(text), 'text': text or scenario_world.NO_DETAILS}


async def play(card: dict, agent: agents.HttpAgent, item: dict, changed: Callable[[], None]) -> None:
    """One conversation of the scenario with the agent, up to MAX_AGENT_TURNS replies, then judged. It says why it
    stopped (stop): the customer's own reason (resolved, instruction, gave_up, ended), the agent handed it off
    (handed_off), or the budget cut it short (budget). The customer's last words before its end mark go to the agent
    too. A conversation the agent or the model broke keeps its turns and says why."""
    conversation = item['conversation']
    shapes = world.templates(connection.repo()) if agent.mocked else None
    test_data = scenario_world.overrides(card.get('world'), shapes) if agent.mocked else {}
    found = customer_details(card, agent, shapes, test_data, item['conversationId'])
    details = found['text']
    # Whether the conversation ran to its end: only such a conversation may be judged again (ended).
    item.update(world=bool(test_data), customerDetails=found, ended=False)
    persona = item.get('persona') or personas.DEFAULT
    line, from_log = opening(card, persona), persona == personas.DEFAULT
    stop = None
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
            if stop:
                break  # the customer's last words are answered
            if not reply['ok']:
                stop = 'handed_off'
                break
            if turn == MAX_AGENT_TURNS:
                stop = 'budget'
                break
            item['stage'] = f'ход {turn + 1}: клиент пишет'
            changed()
            (line, stop), from_log = customer.ending(await customer_says(card, conversation, details, persona)), False
            if stop and not line:
                break
            if not line:
                raise models.ModelError('Модель клиента не написала реплику.')
        item.update(ended=True, stop=stop)
        item['stage'] = 'модель оценивает'
        changed()
        await evaluate(card, item)
    except (agents.AgentError, models.ModelError) as error:
        item.update(status='UNMEASURED', error=str(error))
    item['stage'] = ''
    changed()


def new_run(key: str, config: dict, label: str, repeats: int, persona_ids: list[str]) -> dict:
    return {
        'id': f'{time.strftime("%Y%m%d-%H%M%S")}-{uuid.uuid4().hex[:8]}',
        'target': key,
        'targetName': config['name'],
        'version': '…',
        'label': label,
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
        'sets': list(card.get('sets') or []),
        'weight': card.get('weight'),
        'scenario': card.get('scenario'),
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
    chosen = [card for card in scenarios.deck() if not card_ids or card['id'] in card_ids]
    if not chosen:
        raise RuntimeError('Нет сценариев для прогона. Сначала соберите сценарии.')
    persona_ids = [p for p in personas.PERSONAS if p in (persona_ids or [personas.DEFAULT])] or [personas.DEFAULT]
    config = connection.ways()[key]
    record = new_run(key, config, label, repeats, persona_ids)
    # Types play the stress set; a scenario of the representative set is played once per repeat, by the ordinary one.
    order = persona_ids if personas.DEFAULT in persona_ids else [personas.DEFAULT, *persona_ids]
    plan = [
        (card, persona, attempt)
        for attempt in range(1, repeats + 1)
        for persona in order
        for card in chosen
        if persona in personas.plays(card, persona_ids)
    ]
    record['items'] = [new_item(card, persona, attempt) for card, persona, attempt in plan]
    # The run is measured by the criteria of the check its deck was built from, and remembers it.
    record['check'] = scenarios.check() or checks.of_run(record)
    storage.runs.create(record)

    def changed(index: int) -> None:
        """A conversation's turns stay in memory, in the job's progress; it is written once, when it ends with a
        verdict or an error. A write rereads and rewrites the whole run, on the event loop that stop also needs."""
        if record['items'][index]['status'] != 'RUNNING':
            storage.runs.update_item(record['id'], index, record['items'][index])
        done = sum(item['status'] != 'RUNNING' for item in record['items'])
        progress(run=record['id'], done=done, total=len(plan), message=f'Играем сценарии · {record["targetName"]}')

    progress(run=record['id'], done=0, total=len(plan), message=f'Подключаемся к агенту · {config["name"]}')
    # The customer's and the judges' calls are about this run in the journal.
    with models.about(f'run:{record["id"]}'):
        try:
            await prepare_openings(chosen, persona_ids, progress)
            async with agents.session(connection.connect(key)) as agent:
                record['version'] = agent.version
                storage.runs.update(record['id'], version=agent.version)
                gate = asyncio.Semaphore(PARALLEL)

                async def one(card: dict, index: int) -> None:
                    async with gate:
                        await play(card, agent, record['items'][index], lambda: changed(index))

                async with asyncio.TaskGroup() as group:
                    for index, (card, _, _) in enumerate(plan):
                        group.create_task(one(card, index))
            # A run the agent answered in no conversation has nothing to judge, now or later: it failed, and says why.
            silent = unanswered(record['items'])
            record.update(status='failed' if silent else 'done', error=silent)
        except asyncio.CancelledError:
            record.update(status='stopped', error='Прогон остановлен')
            raise
        except Exception as error:
            record.update(status='failed', error=error_text(error))
        finally:
            # What the stop or the failure cut short, with the final status, in one write: not one per conversation.
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
    return storage.runs.get(record['id'])


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
    it was, never half re-judged under a final status. A pass in which the model gave no verdict on some conversation
    failed: an outage is not a verdict, and writing one would take the verdicts that stood and the answers people gave
    on them (storage.runs.update_items)."""
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
    done, failed = 0, Counter()

    async def one(item: dict) -> None:
        nonlocal done
        try:
            await evaluate(item, item)
            item['error'] = None
        except models.ModelError as error:
            failed[str(error)] += 1
        done += 1
        progress(done=done, total=len(items), message='Оцениваем разговоры заново')

    with models.about(f'run:{record["id"]}'):
        async with asyncio.TaskGroup() as group:
            for _, item in items:
                group.create_task(one(item))
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


async def evidence(card: dict, conversation: list[dict]) -> judge.Evidence:
    """What both judges see of a played conversation, with the knowledge articles the agent read in it."""
    shown = [{'role': m['role'].upper(), 'text': for_judge(m)} for m in conversation]
    replies = [message for message in conversation if message['role'] == 'agent']
    # The agent's words and its buttons' labels: the agent wrote both, the Lab's «[Кнопки: …]» around them it did not.
    agent_text = '\n'.join(line for reply in replies for line in (reply['text'], *(reply.get('options') or [])))
    calls = '\n'.join(call for reply in replies for call in tool_calls(reply))
    retrieved = await asyncio.to_thread(knowledge.retrieved, connection.repo(), conversation)
    payload = {
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
    """Judge a run's conversation in place: rows, verdict and the second judge's verdict."""
    prepared = await evidence(card, item['conversation'])
    try:
        async with asyncio.TaskGroup() as tasks:
            primary = tasks.create_task(judge.run_verdict(prepared))
            secondary = tasks.create_task(judge.second_opinion(judge.run_verdict, prepared))
    except* models.ModelError as errors:
        raise models.ModelError(str(errors.exceptions[0])) from errors
    result = primary.result()
    item.update(rules=result.rows, status=result.status, model=result.model, judgeVersion=result.version)
    item['second'] = secondary.result()
