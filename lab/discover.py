"""Log audit: real conversations from the logs judged against rules grounded in the agent's prompts and tools.

Rules are extracted once and then frozen: a new audit reuses them and keeps every known conversation in its topic,
so two audits are measured against the same rules. «Новые правила» (replan) extracts them again.
"""

import asyncio
import random
import time
from collections import Counter
from collections.abc import Callable

from . import judge, llm, logs, quotes, store, workshop
from .context import sources
from .prompts import ASSIGN, PLAN

RESULT = 'discover.json'
FOLDER = 'Agent Lab · Логи'
SEED = 20260928  # the same sample of conversations in every audit
TASK = 'Проверить ответы чат-бота эквайринга СберБизнеса на реальных обращениях клиентов'
OBSERVATIONS = ('reply', 'tool', 'state')


def sample(count: int) -> list[dict]:
    rows = logs.load()
    random.Random(SEED).shuffle(rows)
    return rows[:count]


def customer_text(dialogue: dict) -> str:
    return '\n'.join(m['content'] for m in dialogue['messages'] if m['role'] == 'user')


def conversation(dialogue: dict) -> list[dict]:
    return [
        {'role': 'CUSTOMER' if m['role'] == 'user' else 'AGENT', 'text': m['content']} for m in dialogue['messages']
    ]


def requests(dialogues: list[dict]) -> list[dict]:
    """What the planner sees of the conversations: short ids (d1..dN) and the customer's words."""
    return [{'id': f'd{i}', 'customer': customer_text(d)[:600]} for i, d in enumerate(dialogues, 1)]


def short_ids(dialogues: list[dict]) -> dict[str, str]:
    return {f'd{i}': str(d['id']) for i, d in enumerate(dialogues, 1)}


def ground(topics: list[dict], srcs: list[dict]) -> tuple[list[dict], int]:
    """Keep the rules whose quote is found verbatim in the cited source; return them and how many were dropped."""
    by_id = {s['id']: s['content'] for s in srcs}
    dropped = 0
    for t_index, topic in enumerate(topics, 1):
        topic['id'] = f't{t_index}'
        kept = []
        for r_index, rule in enumerate(topic.get('rules') or [], 1):
            text = by_id.get(rule.get('sourceId')) or next(iter(by_id.values()), '')
            if not quotes.found(rule.get('quote', ''), text):
                dropped += 1
                continue
            rule['id'] = f'{topic["id"]}r{r_index}'
            if rule.get('observation') not in OBSERVATIONS:
                rule['observation'] = 'reply'
            kept.append(rule)
        topic['rules'] = kept
    return topics, dropped


async def plan_topics(srcs: list[dict], dialogues: list[dict]) -> tuple[list[dict], int]:
    """New topics and rules from the sources; every sampled conversation is put into one topic."""

    def check(value: dict) -> None:
        if not isinstance(value.get('topics'), list) or not value['topics']:
            raise ValueError('no topics')

    payload = {'task': TASK, 'sources': srcs, 'dialogues': requests(dialogues)}
    plan = await llm.structured(PLAN, payload, check=check)
    topics, dropped = ground(plan['topics'], srcs)
    topics = [t for t in topics if t['rules']]
    real = short_ids(dialogues)
    for topic in topics:
        topic['dialogueIds'] = [real[str(i)] for i in topic.get('dialogueIds') or [] if str(i) in real]
    return topics, dropped


async def keep_topics(previous: dict, dialogues: list[dict]) -> list[dict]:
    """The frozen topics: a known conversation keeps its topic, new ones are sorted into the existing topics."""
    known = {str(r['dialogueId']): r['topicId'] for r in previous.get('results') or []}
    new = [d for d in dialogues if str(d['id']) not in known]
    topics = [dict(t, dialogueIds=[]) for t in previous['topics']]
    if new:
        payload = {'topics': [{'id': t['id'], 'title': t['title']} for t in topics], 'dialogues': requests(new)}
        value = await llm.structured(ASSIGN, payload, check=lambda v: v['assignments'])
        real, ids = short_ids(new), {t['id'] for t in topics}
        for a in value['assignments']:
            if a.get('topicId') in ids and str(a.get('dialogueId')) in real:
                known[real[str(a['dialogueId'])]] = a['topicId']
    for topic in topics:
        topic['dialogueIds'] = [str(d['id']) for d in dialogues if known.get(str(d['id'])) == topic['id']]
    return topics


def note(topic: dict, result: dict) -> str:
    context = f'Записанный разговор из логов · тема «{topic["title"]}»'
    return judge.note(
        result['status'], context, result['rules'], result.get('error'), result.get('second'), recorded=True
    )


def trace_log(dialogue: dict, topic: dict, result: dict, use_workshop: bool) -> dict:
    """The logged conversation in Workshop with the judge's verdict and note."""
    status, rows = result['status'], result['rules']
    fails = [r for r in rows if r['status'] == 'FAIL']
    headline = (fails[0]['title'] or fails[0]['rule']) if fails else topic['title']
    trace = workshop.Trace(
        f'{judge.MARKS[status]} Лог · {headline}'[:120],
        convo_id=f'log-{dialogue["id"]}',
        user_id='логи',
        properties={'source': 'production-log', 'topic': topic['title'], 'verdict': status},
        enabled=use_workshop,
    )
    history = []
    for message in dialogue['messages']:
        if message['role'] == 'user':
            history.append({'role': 'user', 'content': message['content']})
        else:
            trace.agent_turn(time.time_ns(), list(history), message['content'], 'Запись из лога')
            history.append({'role': 'assistant', 'content': message['content']})
    trace.tool(
        'Судья',
        time.time_ns(),
        {'правила': [r['rule'] for r in rows]},
        {r['ruleId']: {'статус': r['status'], 'почему': r['reason']} for r in rows},
    )
    trace.finish(status)
    trace.annotate(workshop.kind_of(status), note(topic, result))
    trace.save_to(FOLDER, dialogue['messages'][0]['content'], status, headline)
    return {'runId': trace.run_id, 'url': trace.url} if trace.enabled else {}


async def judge_dialogue(dialogue: dict, topic: dict, use_workshop: bool) -> dict:
    rules, shown = topic['rules'], conversation(dialogue)
    try:
        rows, status = await judge.log_verdict(rules, shown)
        second, error = await judge.second_opinion(judge.log_verdict, rules, shown), None
    except llm.ModelError as exc:
        rows = judge.checked([], rules, '')
        status, second, error = judge.verdict_of(rows), None, str(exc)
    result = {
        'dialogueId': dialogue['id'],
        'topicId': topic['id'],
        'status': status,
        'rules': rows,
        'second': second,
        'opening': dialogue['messages'][0]['content'],
        'error': error,
    }
    result.update(await asyncio.to_thread(trace_log, dialogue, topic, result, use_workshop))
    return result


def carry_reviews(previous: dict, results: list[dict]) -> None:
    """A person's decision stays with a verdict that did not change: the same conversation, rule and status.
    Only with frozen rules: extracted anew, the same rule id may be another rule."""
    kept = {
        (str(r['dialogueId']), row['ruleId'], row['status']): row['review']
        for r in previous.get('results') or []
        for row in r.get('rules') or []
        if row.get('review') in ('agree', 'disagree')
    }
    for result in results:
        for row in result['rules']:
            decision = kept.get((str(result['dialogueId']), row['ruleId'], row['status']))
            if decision:
                row['review'] = decision


def summarize(results: list[dict], topics: list[dict]) -> dict:
    """Counts, the second judge's agreement and the recurring violations, most frequent first."""
    measured = [r for r in results if r['status'] != 'UNMEASURED']
    failed = [r for r in results if r['status'] == 'FAIL']
    # One problem = one quote from the source: the same rule restated in several topics is merged.
    patterns: dict[str, dict] = {}
    rules = {rule['id']: (topic, rule) for topic in topics for rule in topic['rules']}
    for result in results:
        for row in result['rules']:
            if row['status'] != 'FAIL' or row['ruleId'] not in rules:
                continue
            topic, rule = rules[row['ruleId']]
            item = patterns.setdefault(
                quotes.normalized(rule['quote']),
                {
                    'ruleId': row['ruleId'],
                    'rule': rule['text'],
                    'quote': rule['quote'],
                    'topics': [],
                    'dialogues': [],
                    'titles': [],
                    'examples': [],
                },
            )
            if topic['title'] not in item['topics']:
                item['topics'].append(topic['title'])
            if result['dialogueId'] in item['dialogues']:
                continue
            item['dialogues'].append(result['dialogueId'])
            if row['title'] and row['title'] not in item['titles']:
                item['titles'].append(row['title'])
            item['examples'].append(
                {
                    'dialogueId': result['dialogueId'],
                    'reason': row['reason'],
                    'agentQuote': row['agentQuote'],
                    'opening': result['opening'],
                    'url': result.get('url'),
                }
            )
    for item in patterns.values():
        item['count'] = len(item['dialogues'])
        item['topic'] = ', '.join(item['topics'])
    twice = [r for r in results if (r.get('second') or {}).get('status') in ('PASS', 'FAIL', 'UNMEASURED')]
    second = None
    if twice:
        agree = sum(1 for r in twice if r['second']['status'] == r['status'])
        second = {'model': twice[0]['second']['model'], 'checked': len(twice), 'agree': agree}
    return {
        'checked': len(results),
        'measured': len(measured),
        'failed': len(failed),
        'passed': len(measured) - len(failed),
        'unmeasured': len(results) - len(measured),
        'secondJudge': second,
        'patterns': sorted(patterns.values(), key=lambda p: -p['count']),
    }


async def run(count: int = 60, progress: Callable[..., None] = lambda **_: None, replan: bool = False) -> dict:
    srcs = sources.load()
    if not srcs:
        raise RuntimeError('Нет источников правил: шаг «агент» → «собрать из кода агента».')
    dialogues = sample(count)
    use_workshop = await asyncio.to_thread(workshop.available)
    previous = store.load(RESULT) or {}
    started = store.now()
    if previous.get('topics') and not replan:
        progress(
            stage='plan', done=0, total=len(dialogues), message='Правила зафиксированы, распределяю разговоры по темам'
        )
        topics = await keep_topics(previous, dialogues)
        dropped = previous.get('droppedRules', 0)
        rules_since = previous.get('rulesSince') or previous.get('startedAt')
    else:
        progress(stage='plan', done=0, total=len(dialogues), message='Выделяю темы и правила из промпта')
        topics, dropped = await plan_topics(srcs, dialogues)
        rules_since = started

    topic_of = {}
    for topic in topics:
        for dialogue_id in topic['dialogueIds']:
            topic_of.setdefault(dialogue_id, topic)
    todo = [(d, topic_of[str(d['id'])]) for d in dialogues if str(d['id']) in topic_of]
    progress(stage='judge', done=0, total=len(todo), message=f'Оцениваю {len(todo)} разговоров')
    results = []

    async def one(dialogue: dict, topic: dict) -> None:
        results.append(await judge_dialogue(dialogue, topic, use_workshop))
        progress(stage='judge', done=len(results), total=len(todo), message=f'Оценено {len(results)} из {len(todo)}')

    await asyncio.gather(*(one(*item) for item in todo))
    order = {str(d['id']): i for i, d in enumerate(dialogues)}
    results.sort(key=lambda r: order.get(str(r['dialogueId']), 0))
    if previous.get('topics') and not replan:
        carry_reviews(previous, results)
    rule_count = Counter(rule.get('sourceId') for topic in topics for rule in topic['rules'])
    value = {
        'startedAt': started,
        'finishedAt': store.now(),
        'model': llm.model_label,
        'rulesSince': rules_since,
        'sources': [
            {
                'id': s['id'],
                'kind': s['kind'],
                'origin': s.get('origin', s.get('name')),
                'sha256': s.get('sha256'),
                'chars': len(s['content']),
                'rules': rule_count[s['id']],
            }
            for s in srcs
        ],
        'sampled': len(dialogues),
        'unassigned': len(dialogues) - len(todo),
        'droppedRules': dropped,
        'topics': topics,
        'results': results,
        'summary': summarize(results, topics),
    }
    store.save(RESULT, value)
    # Only now the previous audit's traces go, with any left by an audit that was stopped midway.
    keep = {r['runId'] for r in results if r.get('runId')}
    for run_id in await asyncio.to_thread(workshop.conversation_runs, 'log-'):
        if run_id not in keep:
            await asyncio.to_thread(workshop.forget, run_id)
    return value
