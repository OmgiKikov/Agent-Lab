"""The live agent on the same customers: the conversations of a check's result played again with the agent under test
(domain.replay), each judged by the same judge and criteria as the recordings, the check kept as it goes.

A check is made by a task and takes its id; its record is what the task continues from after a restart: the
conversations that ended are judged, the others are played again from the start (the agent keeps what it was told
under a conversation's id, so going on with one would tell it a line twice). A stop ends the check as it stands.
"""

import asyncio
import time
import uuid
from collections.abc import Callable
from copy import deepcopy

from .. import agents, models, storage
from ..domain import checks
from ..domain import replay as pairs
from ..domain import tone as tone_rules
from ..domain.transcript import with_buttons
from ..roles import customer
from . import Progress, connection, conversations, error_text, simulation
from .checks import current

PARALLEL = 4  # conversations played at once, as in a run of scenarios
PLAYING = 'Проверяем живого агента'


def new_id() -> str:
    """A check's id: when it started, then a few random letters."""
    return f'{time.strftime("%Y%m%d-%H%M%S")}-{uuid.uuid4().hex[:8]}'


def ready(check: str) -> tuple[dict, dict]:
    """The result whose customers the agent meets again, and its export; ValueError, saying why, when there is none."""
    result = current(check) or {}
    if not result.get('checkId') or not result.get('results'):
        raise ValueError(f'У проверки «{checks.NAMES[check]}» ещё нет итога. Сначала проверьте записанные разговоры.')
    export = storage.exports.get(conversations.export_of(result))
    if export is None:
        raise ValueError('Выгрузки этого итога уже нет. Проверьте разговоры другой выгрузки.')
    if not pairs.chosen(result, 1):
        raise ValueError('В итоге нет проверенных разговоров: модели не удалось оценить ни один.')
    return result, export


def new_item(dialogue: dict, verdict: dict) -> dict:
    """One customer to meet again: the recording with its verdict, and the conversation to play."""
    keep = ('ruleId', 'status', 'agentQuote', 'reason', 'title')
    second = verdict.get('second') or None
    return {
        'dialogueId': str(dialogue['id']),
        'topicId': verdict['topicId'],
        'opening': pairs.opening(dialogue),
        'replies': pairs.replies(dialogue),
        'situation': pairs.situation(dialogue),
        'recorded': dialogue['messages'],
        'before': {
            'status': verdict['status'],
            'rules': [{key: row.get(key) for key in keep} for row in verdict.get('rules') or []],
            'model': verdict.get('model'),
            'judgeVersion': verdict.get('judgeVersion'),
            'second': second and {key: second.get(key) for key in ('model', 'status', 'judgeVersion')},
        },
        'status': 'RUNNING',
        'stage': 'в очереди',
        'conversationId': str(uuid.uuid4()),
        'conversation': [],
        'rules': [],
        'second': None,
        'error': None,
        'ended': False,
    }


def begun(check: str, key: str, count: int, replay_id: str | None = None) -> dict:
    """A new check of the live agent, saved before the first conversation: the customers of the check's result, its
    criteria frozen as they were, the agent's way of being reached."""
    result, export = ready(check)
    chosen = pairs.chosen(result, count)
    dialogues = {str(d['id']): d for d in storage.exports.read(export['id'], chosen)}
    verdicts = {str(r['dialogueId']): r for r in result['results']}
    config = connection.ways()[key]
    record = {
        'id': replay_id or new_id(),
        'check': check,
        'target': key,
        'targetName': config['name'],
        'version': simulation.PENDING_VERSION,
        'customer': config.get('customer', ''),
        'startedAt': storage.now(),
        'finishedAt': None,
        'status': 'running',
        'error': None,
        'model': models.main_model(),
        'basis': {
            'checkId': result['checkId'],
            'finishedAt': result.get('finishedAt'),
            'export': storage.exports.line(export),
        },
        'topics': [dict(deepcopy(topic), dialogueIds=[]) for topic in result.get('topics') or []],
        'items': [new_item(dialogues[i], verdicts[i]) for i in chosen if i in dialogues],
    }
    return storage.replays.create(record)


def continued(record: dict) -> dict:
    """A check a process before this one left running: the conversations that did not end are played again."""
    again = {
        index: simulation.replayed(item)
        for index, item in enumerate(record['items'])
        if item['status'] == 'RUNNING' and not item.get('ended')
    }
    return storage.replays.update_items(record['id'], again) if again else record


def judged_by(record: dict, topic_id: str) -> dict:
    """The topic of a conversation with its criteria as the check judged them: tone of voice's with the clarifications
    people confirmed (tone.for_judging), as its check gives them to the judge."""
    topic = next(t for t in record['topics'] if t['id'] == topic_id)
    if record['check'] == checks.TONE:
        return {**topic, 'rules': [tone_rules.for_judging(rule) for rule in topic['rules']]}
    return topic


async def play(item: dict, agent: agents.HttpAgent, details: str, changed: Callable[[], None]) -> bool:
    """One conversation with the agent: the real first message, then the synthetic customer, as many replies of the
    agent as in the recording. Whether it ran to its end; one the agent or the model broke keeps its turns and says
    why."""
    conversation = item['conversation']
    line = item['opening']
    try:
        for turn in range(1, item['replies'] + 1):
            conversation.append({'role': 'customer', 'text': line, 'fromLog': turn == 1})
            item['stage'] = f'ход {turn}: агент отвечает'
            changed()
            reply = await agent.say(item['conversationId'], line, {})
            conversation.append({'role': 'agent', **reply})
            changed()
            if not reply['text']:
                raise agents.AgentError(f'Агент не прислал текст ответа (статус {reply["status"]}).')
            if not reply['ok'] or turn == item['replies']:
                break
            item['stage'] = f'ход {turn + 1}: клиент пишет'
            changed()
            transcript = '\n\n'.join(
                ('КЛИЕНТ (это ты): ' if m['role'] == 'customer' else 'АГЕНТ: ') + with_buttons(m) for m in conversation
            )
            line = (await customer.reply(item['situation'], transcript, details)).value
            if customer.END in line or not line:
                break
        item['ended'] = True
        return True
    except (agents.AgentError, models.ModelError) as error:
        item.update(status='UNMEASURED', error=str(error), stage='')
        changed()
        return False


async def judge(record: dict, item: dict, changed: Callable[[], None]) -> None:
    """A conversation that ran to its end, judged as a recorded one by the judge of the recordings."""
    item['stage'] = 'модель оценивает'
    changed()
    found = await conversations.judge_dialogue(pairs.as_dialogue(item), judged_by(record, item['topicId']))
    keep = ('status', 'rules', 'second', 'error', 'model', 'judgeVersion')
    item.update({key: found.get(key) for key in keep}, stage='')
    changed()


async def run(check: str, key: str, count: int, progress: Progress = lambda **_: None) -> dict:
    """The check of the live agent made by the task it runs in: begun, or continued after a restart (the task's id is
    the check's); a stop or a failure stands."""
    task_id = storage.tasks.current_id()
    record = storage.replays.get(task_id) if task_id else None
    if record is None:
        record = begun(check, key, count, task_id)
    elif record['status'] != 'running':
        return record
    else:
        record = continued(record)
    # The conversations written as ended already: a restart found them so, or play() wrote them so (changed).
    ended_before = {i for i, item in enumerate(record['items']) if item['status'] == 'RUNNING' and item.get('ended')}

    def changed(index: int) -> None:
        """A conversation is written when it ends (before it is judged) and when it has its verdict or its error; its
        turns until then stay in memory."""
        item = record['items'][index]
        if item['status'] != 'RUNNING' or (item.get('ended') and index not in ended_before):
            if item['status'] == 'RUNNING':
                ended_before.add(index)
            storage.replays.update_items(record['id'], {index: item})
            storage.tasks.keep(f'conversation:{index}:{"ended" if item["status"] == "RUNNING" else "measured"}', True)
        done = sum(item['status'] != 'RUNNING' for item in record['items'])
        progress(
            replay=record['id'], done=done, total=len(record['items']), message=f'{PLAYING} · {record["targetName"]}'
        )

    done = sum(item['status'] != 'RUNNING' for item in record['items'])
    progress(
        replay=record['id'],
        done=done,
        total=len(record['items']),
        message=f'Подключаемся к агенту · {record["targetName"]}',
    )
    with models.about(f'replay:{record["id"]}'):
        try:
            async with agents.session(connection.connect(key)) as agent:
                simulation.same_agent(record, agent.version)
                record['version'] = agent.version
                storage.replays.update(record['id'], version=agent.version)
                await play_all(record, agent, changed)
            silent = simulation.unanswered(record['items'])
            record.update(status='failed' if silent else 'done', error=silent)
        except asyncio.CancelledError:
            if not storage.tasks.closing():
                record.update(status='stopped', error='Проверка остановлена')
            raise
        except Exception as error:
            record.update(status='failed', error=error_text(error))
        finally:
            # The Lab closing leaves the check as it is, for the next process to continue (storage.tasks.closing).
            if not storage.tasks.closing():
                finish(record)
    return storage.replays.get(record['id'])


async def play_all(record: dict, agent: agents.HttpAgent, changed: Callable[[int], None]) -> None:
    """The conversations not measured yet, a few at a time: one that ended is judged, the others are played first."""
    gate = asyncio.Semaphore(PARALLEL)

    async def one(index: int) -> None:
        item = record['items'][index]
        async with gate:
            if item.get('ended') or await play(item, agent, record.get('customer', ''), lambda: changed(index)):
                await judge(record, item, lambda: changed(index))

    async with asyncio.TaskGroup() as group:
        for index, item in enumerate(record['items']):
            if item['status'] == 'RUNNING':
                group.create_task(one(index))


def finish(record: dict) -> None:
    """What the stop or the failure cut short, with the final status, in one write."""
    cut = {}
    for index, item in enumerate(record['items']):
        if item['status'] == 'RUNNING':
            item.update(status='UNMEASURED', stage='', error=record['error'])
            cut[index] = item
    storage.replays.update_items(
        record['id'],
        cut,
        status=record['status'],
        error=record['error'],
        finishedAt=storage.now(),
        model=models.models_used(record['items']),
    )
