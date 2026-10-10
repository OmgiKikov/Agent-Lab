"""Replay the actual customer's messages, not model-generated messages, and keep both sides of every pair."""

import asyncio
import time
import uuid

from .. import agents, models, storage
from ..domain import checks, metric
from ..domain.tone import for_judging, read_alike
from . import Progress, agent_context, check_setup, connection, conversations, error_text, provenance

# How often a run writes its record while it goes, at most: once a second.
SAVE_EVERY = 1.0


async def run(
    check: str,
    target: str,
    count: int,
    progress: Progress,
    run_id: str,
    *,
    rule_ids: list[str] | None = None,
    replan: bool = False,
) -> dict:
    """The recorded questions asked of the agent again and its new answers judged: by the chosen criteria of tone of
    voice (rule_ids, all when none), by the criteria of Точность read anew from the code when replan."""
    record = storage.launches.get('questions', run_id)
    if record is None:
        record = await _new(check, target, count, progress, run_id, rule_ids, replan)
    if record['status'] == 'done':
        return record
    record['status'] = 'running'
    record.pop('error', None)
    progress(
        done=sum(i['status'] != 'RUNNING' for i in record['items']),
        total=len(record['items']),
        message='Отправляем исходные вопросы агенту',
    )
    try:
        async with agents.session(connection.connect(target)) as agent:
            known = record['version']
            if known not in ('…', agents.UNKNOWN_VERSION) and agent.version != known:
                raise ValueError('Версия агента на стенде изменилась. Запустите новую проверку.')
            record['version'] = agent.version
            slots = asyncio.Semaphore(min(4, models.concurrency()))
            criteria = {topic['id']: topic['rules'] for topic in record.get('topics') or []}
            saved = time.monotonic()

            async def one(index: int) -> None:
                nonlocal saved
                item = record['items'][index]
                if item['status'] in ('PASS', 'FAIL', 'NOT_APPLICABLE'):
                    return
                async with slots:
                    # A record of an earlier Lab keeps each item's criteria in the item.
                    await _play(agent, item, item.get('criteria') or criteria.get(item.get('topicId')) or [])
                record['metric'] = metric.metric(record['items'])
                # The whole record is written at most once a second (and at the end, _finish): written after every
                # answer, a long run would write it again and again in full. An answer not written yet is asked again
                # after a restart.
                if time.monotonic() - saved >= SAVE_EVERY:
                    storage.launches.save('questions', record)
                    saved = time.monotonic()
                storage.tasks.keep(f'question:{index}', True)
                progress(
                    done=sum(i['status'] != 'RUNNING' for i in record['items']),
                    total=len(record['items']),
                    message='Проверяем новые ответы агента',
                )

            with models.about(f'questions:{run_id}'):
                async with asyncio.TaskGroup() as group:
                    for index in range(len(record['items'])):
                        group.create_task(one(index))
        record['status'] = 'done' if any(i['status'] in ('PASS', 'FAIL') for i in record['items']) else 'failed'
    except asyncio.CancelledError:
        if not storage.tasks.closing():
            record['status'] = 'stopped'
        raise
    except Exception as error:
        record.update(status='failed', error=error_text(error))
    finally:
        _finish(record)
    return record


def _finish(record: dict) -> None:
    if record['status'] in ('failed', 'stopped'):
        for item in record['items']:
            if item['status'] == 'RUNNING':
                item.update(
                    status='UNMEASURED', error=record.get('error') or 'Разговор не завершён: проверка остановлена.'
                )
    if record['status'] == 'failed' and not record.get('error'):
        record['error'] = 'Не удалось оценить новые ответы. Откройте разговоры с причиной или повторите проверку.'
    record['metric'] = metric.metric(record['items'])
    if record['status'] != 'running':
        record['finishedAt'] = storage.now()
    storage.launches.save('questions', record)


async def _new(
    check: str,
    target: str,
    count: int,
    progress: Progress,
    run_id: str,
    rule_ids: list[str] | None = None,
    replan: bool = False,
) -> dict:
    dialogues = conversations.sample(count)
    if not dialogues:
        raise ValueError('В выбранном датасете нет разговоров.')
    topics = await check_setup.topics(check, dialogues, progress, rule_ids=rule_ids, replan=replan)
    by_dialogue = {str(i): topic for topic in topics for i in topic['dialogueIds']}
    baseline = storage.documents.load(checks.result(check)) or {}
    base_rules = {t['id']: t['rules'] for t in baseline.get('topics', [])}
    base_rows = {str(r['dialogueId']): r for r in baseline.get('results', [])}
    items = []
    for dialogue in dialogues:
        topic = by_dialogue.get(str(dialogue['id']))
        item = _item(dialogue, topic)
        before = base_rows.get(str(dialogue['id']))
        # The recorded answers are the baseline while the judge reads their criteria as it reads these: renamed since,
        # a criterion is the same one.
        if before and topic and read_alike(base_rules.get(before['topicId']) or [], topic['rules']):
            item['baseline'] = before
            item['sameContext'] = check == 'tone' or _context(baseline.get('agentContext') or {}) == _context(
                agent_context.current()
            )
        items.append(item)
    record = {
        'id': run_id,
        'check': check,
        'mode': 'questions',
        'target': target,
        'startedAt': storage.now(),
        'status': 'running',
        # The criteria once for the run, by topic; an item names its topic.
        'topics': [{'id': topic['id'], 'title': topic.get('title', ''), 'rules': topic['rules']} for topic in topics],
        'items': items,
        'metric': None,
        'version': '…',
        **provenance.snapshot(check),
    }
    storage.launches.save('questions', record)
    return record


def _item(dialogue: dict, topic: dict | None) -> dict:
    return {
        'cardId': f'recorded-{dialogue["id"]}',
        'dialogueId': dialogue['id'],
        'name': dialogue['messages'][0]['content'],
        'original': dialogue['messages'],
        'conversation': [],
        'status': 'RUNNING',
        'rules': [],
        'topicId': topic['id'] if topic else None,
        'topic': topic['title'] if topic else '',
        'error': None,
    }


async def _play(agent: agents.HttpAgent, item: dict, criteria: list[dict]) -> None:
    """One recorded conversation asked again and its new answers judged by the criteria of its topic, as the check of
    the recorded answers judges them: with the clarifications people confirmed (for_judging), so the two compare."""
    item.update(conversation=[], rules=[], error=None, status='RUNNING')
    if not criteria:
        item.update(status='UNMEASURED', error='Для этого разговора не определены критерии.')
        return
    original = [m['content'] for m in item['original'] if m['role'] == 'user']
    if len(original) > 50:
        item.update(status='UNMEASURED', error='В разговоре больше 50 вопросов. Подготовьте более короткий разговор.')
        return
    conversation_id = str(uuid.uuid4())
    try:
        for question in original:
            item['conversation'].append({'role': 'customer', 'text': question})
            reply = await agent.say(conversation_id, question)
            item['conversation'].append({'role': 'agent', 'text': reply.get('text') or '', **reply})
            if not reply.get('ok', True):
                break
        # A reply keeps the systems the agent called in it (events): the judge's only evidence of a call.
        transcript = {
            'id': item['dialogueId'],
            'messages': [
                {
                    'role': 'user' if m['role'] == 'customer' else 'assistant',
                    'content': m['text'],
                    'events': m.get('events') or [],
                }
                for m in item['conversation']
                if m['text'].strip() or m.get('events')
            ],
        }
        judged = {'id': 'replay', 'rules': [for_judging(rule) for rule in criteria]}
        result = await conversations.judge_dialogue(transcript, judged)
        item.update({key: result[key] for key in ('rules', 'status', 'model', 'judgeVersion', 'error', 'second')})
        item.update(knowledge=result.get('knowledge'), contextError=result.get('contextError'))
        before = item.get('baseline') or {}
        item['comparable'] = (
            item.get('sameContext', False)
            and bool(before.get('model'))
            and all(before.get(key) == item.get(key) for key in ('model', 'judgeVersion', 'knowledge'))
        )
    except models.RateLimited:
        raise  # every next question would meet the same limit of the model: the run stops, to be continued later
    except (agents.AgentError, models.ModelError) as error:
        item.update(status='UNMEASURED', error=str(error))


def _context(value: dict) -> dict:
    return {key: value.get(key) or '' for key in ('idpUrl', 'idpIndex', 'idpFilter', 'idpEmbedder')} | {
        'tools': sorted(value.get('tools') or []),
    }
