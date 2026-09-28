"""Step 1: evaluate real logged conversations against rules grounded in the owner's sources."""
import asyncio
import json
import random
import time

from . import llm, store, workshop
from .prompts import ASSIGN, JUDGE_LOG, PLAN

STATUSES = {'PASS', 'FAIL', 'UNKNOWN', 'NOT_APPLICABLE'}


def logs() -> list[dict]:
    path = store.DATA / 'logs.jsonl'
    rows = [json.loads(line) for line in path.read_text(encoding='utf-8').splitlines() if line.strip()]
    return [r for r in rows if len(r.get('messages') or []) >= 2 and r['messages'][0].get('role') == 'user']


def sources() -> list[dict]:
    return store.load('sources.json', [])


def sample(count: int) -> list[dict]:
    rows = logs()
    random.Random(20260928).shuffle(rows)
    return rows[:count]


def customer_text(dialogue: dict) -> str:
    return '\n'.join(m['content'] for m in dialogue['messages'] if m['role'] == 'user')


def conversation(dialogue: dict) -> list[dict]:
    return [{'role': 'CUSTOMER' if m['role'] == 'user' else 'AGENT', 'text': m['content']}
            for m in dialogue['messages']]


def _check_plan(value: dict) -> None:
    if not isinstance(value.get('topics'), list) or not value['topics']:
        raise ValueError('no topics')


def ground(topics: list[dict], srcs: list[dict]) -> tuple[list[dict], int]:
    """Drop every rule whose quote is not found verbatim in the cited source."""
    by_id = {s['id']: s['content'] for s in srcs}
    dropped = 0
    seen = set()
    for t_index, topic in enumerate(topics, 1):
        topic['id'] = f't{t_index}'
        kept = []
        for r_index, rule in enumerate(topic.get('rules') or [], 1):
            text = by_id.get(rule.get('sourceId')) or next(iter(by_id.values()), '')
            if not store.quote_found(rule.get('quote', ''), text):
                dropped += 1
                continue
            rule['id'] = f'{topic["id"]}r{r_index}'
            if rule['id'] in seen:
                continue
            seen.add(rule['id'])
            rule['observation'] = rule.get('observation') if rule.get('observation') in ('reply', 'tool', 'state') else 'reply'
            kept.append(rule)
        topic['rules'] = kept
    return topics, dropped


def verdict_of(rows: list[dict]) -> str:
    statuses = {r['status'] for r in rows}
    if 'FAIL' in statuses:
        return 'FAIL'
    if 'PASS' in statuses:
        return 'PASS'
    return 'UNMEASURED'


def checked(rows: list[dict], rules: list[dict], agent_text: str) -> list[dict]:
    """One row per rule; a PASS/FAIL without a verbatim agent quote becomes UNKNOWN."""
    by_rule = {r.get('ruleId'): r for r in rows if isinstance(r, dict)}
    out = []
    for rule in rules:
        row = by_rule.get(rule['id']) or {'status': 'UNKNOWN', 'reason': 'Судья не вернул оценку этого правила.', 'agentQuote': ''}
        status = row.get('status') if row.get('status') in STATUSES else 'UNKNOWN'
        reason = str(row.get('reason') or '')
        quote = str(row.get('agentQuote') or '')
        if status in ('PASS', 'FAIL') and not store.quote_found(quote, agent_text):
            status, reason = 'UNKNOWN', 'Цитата судьи не найдена в ответах агента; вывод не засчитан. ' + reason
        out.append({'ruleId': rule['id'], 'rule': rule['text'], 'status': status, 'reason': reason,
                    'agentQuote': quote if status in ('PASS', 'FAIL') else '', 'title': str(row.get('title') or '')})
    return out


def verdict_note(status: str, context: str, rows: list[dict], error: str | None = None, second: dict | None = None,
                 recorded: bool = False) -> str:
    """Judge's explanation for a person: the reason first, then each criterion with the agent's quote."""
    fail = next((r for r in rows if r['status'] == 'FAIL'), None)
    ok = next((r for r in rows if r['status'] == 'PASS'), None)
    if status == 'FAIL':
        head = ('Нарушение: ' if recorded else 'Не пройден: ') + fail['reason']
    elif status == 'PASS':
        head = ('Без нарушений: ' if recorded else 'Пройден: ') + ok['reason']
    else:
        head = 'Не измерено: ' + (error or 'у судьи нет доказательств ни по одному критерию — ни выполнения, ни нарушения.')
    mark = {'PASS': '✓', 'FAIL': '✗', 'UNKNOWN': '?', 'NOT_APPLICABLE': '–'}
    lines = [head, '', context]
    if second and second.get('status') in ('PASS', 'FAIL', 'UNMEASURED'):
        words = {'PASS': 'пройден', 'FAIL': 'не пройден', 'UNMEASURED': 'не измерено'}
        agree = 'согласен' if second['status'] == status else f"не согласен: по его оценке {words[second['status']]}"
        lines.append(f"Второй судья ({second.get('model')}): {agree}.")
    for r in rows:
        lines += ['', f"{mark[r['status']]} {r['rule']}", f"   {r['reason']}"]
        if r['agentQuote']:
            lines.append(f"   Цитата агента: «{r['agentQuote']}»")
    return '\n'.join(lines)


def trace_log(dialogue: dict, topic: dict, rows: list[dict], status: str, use_workshop: bool, second: dict | None = None) -> dict:
    fails = [r for r in rows if r['status'] == 'FAIL']
    label = {'FAIL': '✗', 'PASS': '✓', 'UNMEASURED': '?'}[status]
    headline = (fails[0]['title'] or fails[0]['rule']) if fails else topic['title']
    trace = workshop.Trace(f'{label} Лог · {headline}'[:120], convo_id='log-' + str(dialogue['id']),
                           user_id='логи', properties={'source': 'production-log', 'topic': topic['title'],
                                                       'verdict': status}, enabled=use_workshop)
    history = []
    for message in dialogue['messages']:
        if message['role'] == 'user':
            history.append({'role': 'user', 'content': message['content']})
        else:
            trace.agent_turn(time.time_ns(), list(history), message['content'], 'Запись из лога')
            history.append({'role': 'assistant', 'content': message['content']})
    trace.tool('Судья', time.time_ns(), {'правила': [r['rule'] for r in rows]},
               {r['ruleId']: {'статус': r['status'], 'почему': r['reason']} for r in rows})
    trace.finish(status)
    note = verdict_note(status, f'Записанный разговор из логов · тема «{topic["title"]}»', rows, second=second, recorded=True)
    trace.annotate('issue' if status == 'FAIL' else 'note', note)
    trace.save_to('Agent Lab · Логи', dialogue['messages'][0]['content'], status, headline)
    return {'runId': trace.run_id, 'url': trace.url} if trace.enabled else {}


async def judge_dialogue(dialogue: dict, topic: dict, use_workshop: bool) -> dict:
    rules = topic['rules']
    agent_text = '\n'.join(m['content'] for m in dialogue['messages'] if m['role'] != 'user')
    try:
        value = await llm.structured(JUDGE_LOG, {'expectations': rules, 'conversation': conversation(dialogue)},
                                     check=lambda v: v['rules'])
        rows = checked(value.get('rules') or [], rules, agent_text)
        error = None
    except llm.ModelError as exc:
        rows = checked([], rules, agent_text)
        error = str(exc)
    status = verdict_of(rows)
    second = None
    if error is None and llm.SECOND:
        try:
            other = await llm.structured(JUDGE_LOG, {'expectations': rules, 'conversation': conversation(dialogue)},
                                         check=lambda v: v['rules'], endpoint=llm.SECOND)
            second = {'model': llm.SECOND[1], 'status': verdict_of(checked(other.get('rules') or [], rules, agent_text))}
        except llm.ModelError as exc:
            second = {'model': llm.SECOND[1], 'status': 'ERROR', 'error': str(exc)}
    workshop_ref = await asyncio.to_thread(trace_log, dialogue, topic, rows, status, use_workshop, second)
    return {'dialogueId': dialogue['id'], 'topicId': topic['id'], 'status': status, 'rules': rows, 'second': second,
            'opening': dialogue['messages'][0]['content'], 'error': error, **workshop_ref}


def summarize(results: list[dict], topics: list[dict]) -> dict:
    measured = [r for r in results if r['status'] != 'UNMEASURED']
    failed = [r for r in results if r['status'] == 'FAIL']
    # One problem = one owner quote: the same rule restated in several topics is merged.
    patterns = {}
    rules = {rule['id']: (topic, rule) for topic in topics for rule in topic['rules']}
    for result in results:
        for row in result['rules']:
            if row['status'] != 'FAIL' or row['ruleId'] not in rules:
                continue
            topic, rule = rules[row['ruleId']]
            item = patterns.setdefault(store.normalized(rule['quote']), {
                'ruleId': row['ruleId'], 'rule': rule['text'], 'quote': rule['quote'],
                'topics': [], 'dialogues': [], 'titles': [], 'examples': []})
            if topic['title'] not in item['topics']:
                item['topics'].append(topic['title'])
            if result['dialogueId'] in item['dialogues']:
                continue
            item['dialogues'].append(result['dialogueId'])
            if row['title'] and row['title'] not in item['titles']:
                item['titles'].append(row['title'])
            item['examples'].append({'dialogueId': result['dialogueId'], 'reason': row['reason'],
                                     'agentQuote': row['agentQuote'], 'opening': result['opening'],
                                     'url': result.get('url')})
    for item in patterns.values():
        item['count'] = len(item['dialogues'])
        item['topic'] = ', '.join(item['topics'])
    twice = [r for r in results if (r.get('second') or {}).get('status') in ('PASS', 'FAIL', 'UNMEASURED')]
    second = {'model': twice[0]['second']['model'], 'checked': len(twice),
              'agree': sum(1 for r in twice if r['second']['status'] == r['status'])} if twice else None
    return {'checked': len(results), 'measured': len(measured), 'failed': len(failed), 'secondJudge': second,
            'passed': len(measured) - len(failed), 'unmeasured': len(results) - len(measured),
            'patterns': sorted(patterns.values(), key=lambda p: -p['count'])}


async def assign(topics: list[dict], dialogues: list[dict]) -> list[dict]:
    """Frozen rules: only sort the new conversations into the existing topics."""
    value = await llm.structured(ASSIGN, {
        'topics': [{'id': t['id'], 'title': t['title']} for t in topics],
        'dialogues': [{'id': f'd{i}', 'customer': customer_text(d)[:600]} for i, d in enumerate(dialogues, 1)],
    }, check=lambda v: v['assignments'])
    known = {t['id'] for t in topics}
    chosen = {str(a.get('dialogueId')): a.get('topicId') for a in value['assignments'] if a.get('topicId') in known}
    fresh = [dict(t, dialogueIds=[]) for t in topics]
    for topic in fresh:
        topic['dialogueIds'] = [short for short, topic_id in chosen.items() if topic_id == topic['id']]
    return fresh


async def run(count: int = 60, progress=lambda **_: None, replan: bool = False) -> dict:
    """Rules are extracted once and then frozen: a new evaluation reuses them unless replan is asked for,
    so the violation rate of two evaluations is measured against the same rules."""
    srcs = sources()
    if not srcs:
        raise RuntimeError('Нет правил владельца: lab/data/sources.json')
    dialogues = sample(count)
    use_workshop = await asyncio.to_thread(workshop.available)
    previous = store.load('discover.json') or {}
    for result in previous.get('results') or []:
        if result.get('runId'):
            await asyncio.to_thread(workshop.forget, result['runId'])
    started = store.now()
    frozen = None if replan else previous.get('topics')
    if frozen:
        progress(stage='plan', done=0, total=len(dialogues), message='Правила зафиксированы, распределяю разговоры по темам')
        # A conversation keeps the topic it already had: its rules must not change between evaluations.
        known = {str(r['dialogueId']): r['topicId'] for r in previous.get('results') or []}
        new = [d for d in dialogues if str(d['id']) not in known]
        topics = await assign(frozen, new) if new else [dict(t, dialogueIds=[]) for t in frozen]
        short = {f'd{i}': str(d['id']) for i, d in enumerate(new, 1)}
        for topic in topics:
            topic['dialogueIds'] = [short.get(i, i) for i in topic['dialogueIds']] + \
                [str(d['id']) for d in dialogues if known.get(str(d['id'])) == topic['id']]
        dropped = previous.get('droppedRules', 0)
        rules_since = previous.get('rulesSince') or previous.get('startedAt')
    else:
        progress(stage='plan', done=0, total=len(dialogues), message='Выделяю темы и правила из промпта')
        plan = await llm.structured(PLAN, {
            'task': 'Проверить ответы чат-бота эквайринга СберБизнеса на реальных обращениях клиентов',
            'sources': srcs,
            'dialogues': [{'id': f'd{i}', 'customer': customer_text(d)[:600]} for i, d in enumerate(dialogues, 1)],
        }, check=_check_plan)
        topics, dropped = ground(plan['topics'], srcs)
        topics = [t for t in topics if t['rules']]
        rules_since = started
        # The model sees short ids (d1..dN); map them back to the real conversation ids.
        short = {f'd{i}': str(d['id']) for i, d in enumerate(dialogues, 1)}
        for topic in topics:
            topic['dialogueIds'] = [short[str(i)] for i in topic.get('dialogueIds') or [] if str(i) in short]
    by_dialogue = {}
    for topic in topics:
        for dialogue_id in topic['dialogueIds']:
            by_dialogue.setdefault(dialogue_id, topic)
    todo = [(d, by_dialogue[str(d['id'])]) for d in dialogues if str(d['id']) in by_dialogue]
    progress(stage='judge', done=0, total=len(todo), message=f'Оцениваю {len(todo)} разговоров')
    results = []

    async def one(item):
        result = await judge_dialogue(*item, use_workshop)
        results.append(result)
        progress(stage='judge', done=len(results), total=len(todo), message=f'Оценено {len(results)} из {len(todo)}')
        return result

    await asyncio.gather(*(one(item) for item in todo))
    order = {str(d['id']): i for i, d in enumerate(dialogues)}
    results.sort(key=lambda r: order.get(str(r['dialogueId']), 0))
    value = {'startedAt': started, 'finishedAt': store.now(), 'model': llm.model_label, 'rulesSince': rules_since,
             'sampled': len(dialogues), 'unassigned': len(dialogues) - len(todo), 'droppedRules': dropped,
             'topics': topics, 'results': results, 'summary': summarize(results, topics)}
    store.save('discover.json', value)
    return value
