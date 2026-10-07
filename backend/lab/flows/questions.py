"""Replay the actual customer's messages, not model-generated messages, and keep both sides of every pair."""

import asyncio
import uuid

from .. import agents, config, models, storage
from ..domain import checks, metric
from . import Progress, agent_context, check_setup, connection, conversations, error_text, provenance


async def run(check: str, target: str, count: int, progress: Progress, run_id: str) -> dict:
    record = storage.launches.get('questions', run_id)
    if record is None:
        record = await _new(check, target, count, progress, run_id)
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
                raise ValueError('Версия агента изменилась. Создайте новый запуск для нового сравнения.')
            record['version'] = agent.version
            slots = asyncio.Semaphore(min(4, config.current().concurrency))

            async def one(index: int) -> None:
                item = record['items'][index]
                if item['status'] in ('PASS', 'FAIL', 'NOT_APPLICABLE'):
                    return
                async with slots:
                    await _play(agent, item)
                record['metric'] = metric.metric(record['items'])
                storage.launches.save('questions', record)
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
                    status='UNMEASURED', error=record.get('error') or 'Разговор не завершён: запуск остановлен.'
                )
    if record['status'] == 'failed' and not record.get('error'):
        record['error'] = 'Не удалось оценить новые ответы. Откройте диалоги с причиной или повторите запуск.'
    record['metric'] = metric.metric(record['items'])
    if record['status'] != 'running':
        record['finishedAt'] = storage.now()
    storage.launches.save('questions', record)


async def _new(check: str, target: str, count: int, progress: Progress, run_id: str) -> dict:
    dialogues = conversations.sample(count)
    if not dialogues:
        raise ValueError('В выбранном датасете нет разговоров.')
    topics = await check_setup.topics(check, dialogues, progress)
    by_dialogue = {str(i): topic for topic in topics for i in topic['dialogueIds']}
    baseline = storage.documents.load(checks.result(check)) or {}
    base_rules = {t['id']: t['rules'] for t in baseline.get('topics', [])}
    base_rows = {str(r['dialogueId']): r for r in baseline.get('results', [])}
    items = []
    for dialogue in dialogues:
        topic = by_dialogue.get(str(dialogue['id']))
        item = _item(dialogue, topic)
        before = base_rows.get(str(dialogue['id']))
        if before and topic and base_rules.get(before['topicId']) == topic['rules']:
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
        'criteria': topic['rules'] if topic else [],
        'topic': topic['title'] if topic else '',
        'error': None,
    }


async def _play(agent: agents.HttpAgent, item: dict) -> None:
    item.update(conversation=[], rules=[], error=None, status='RUNNING')
    if not item['criteria']:
        item.update(status='UNMEASURED', error='Для этого разговора не определены критерии.')
        return
    original = [m['content'] for m in item['original'] if m['role'] == 'user']
    if len(original) > 50:
        item.update(status='UNMEASURED', error='В разговоре больше 50 вопросов. Подготовьте более короткий диалог.')
        return
    conversation_id = str(uuid.uuid4())
    try:
        for question in original:
            item['conversation'].append({'role': 'customer', 'text': question})
            reply = await agent.say(conversation_id, question)
            item['conversation'].append({'role': 'agent', 'text': reply.get('text') or '', **reply})
            if not reply.get('ok', True):
                break
        transcript = {
            'id': item['dialogueId'],
            'messages': [
                {'role': 'user' if m['role'] == 'customer' else 'assistant', 'content': m['text']}
                for m in item['conversation']
                if m['text'].strip()
            ],
        }
        result = await conversations.judge_dialogue(transcript, {'id': 'replay', 'rules': item['criteria']})
        item.update({key: result[key] for key in ('rules', 'status', 'model', 'judgeVersion', 'error', 'second')})
        item.update(knowledge=result.get('knowledge'), contextError=result.get('contextError'))
        before = item.get('baseline') or {}
        item['comparable'] = (
            item.get('sameContext', False)
            and bool(before.get('model'))
            and all(before.get(key) == item.get(key) for key in ('model', 'judgeVersion', 'knowledge'))
        )
    except (agents.AgentError, models.ModelError) as error:
        item.update(status='UNMEASURED', error=str(error))


def _context(value: dict) -> dict:
    return {key: value.get(key) or '' for key in ('idpUrl', 'idpIndex', 'idpFilter', 'idpEmbedder')} | {
        'tools': sorted(value.get('tools') or []),
    }
