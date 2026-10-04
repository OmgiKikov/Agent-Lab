"""Log audit: real conversations from the logs judged against rules grounded in the agent's prompts and tools.

Rules are extracted once and then frozen: a new audit reuses them and keeps every known conversation in its topic,
so two audits are measured against the same rules. «Новые правила» (replan) extracts them again. A new export keeps
them too (checks.CODE_CRITERIA): its conversations are sorted into the same topics, and the two checks compare.
"""

import asyncio
import random
import uuid
from collections import Counter
from collections.abc import Callable

from . import checks, history, judge, llm, logs, quotes, store
from .context import sources
from .prompts import ASSIGN, PLAN

RESULT = checks.result(checks.CODE)  # discover.json: the accuracy result; tone of voice keeps its own (tone.RESULT)
SEED = 20260928  # the same sample of conversations in every audit
TASK = 'Проверить ответы чат-бота эквайринга СберБизнеса на реальных обращениях клиентов'
TONE = checks.TONE_OF_VOICE  # tone.KIND: the kind of the communication rules among the sources
OBSERVATIONS = ('reply', 'tool', 'state')
UNANSWERED = 'Модель проверки не ответила ни по одному разговору.'


def sample(count: int) -> list[dict]:
    rows = logs.load()
    random.Random(SEED).shuffle(rows)
    return rows[:count]


def customer_text(dialogue: dict) -> str:
    return '\n'.join(m['content'] for m in dialogue['messages'] if m['role'] == 'user')


def conversation(dialogue: dict) -> list[dict]:
    return [
        {'role': 'CUSTOMER', 'text': m['content']}
        if m['role'] == 'user'
        else {'role': 'AGENT', 'text': logs.as_seen(m['content'])}
        for m in dialogue['messages']
    ]


def requests(dialogues: list[dict]) -> list[dict]:
    """What the planner sees of the conversations: short ids (d1..dN) and the customer's words."""
    return [{'id': f'd{i}', 'customer': customer_text(d)[:600]} for i, d in enumerate(dialogues, 1)]


def short_ids(dialogues: list[dict]) -> dict[str, str]:
    return {f'd{i}': str(d['id']) for i, d in enumerate(dialogues, 1)}


def ground(topics: list[dict], srcs: list[dict]) -> tuple[list[dict], int]:
    """Keep the rules whose quote is found verbatim in the cited source; return them and how many were dropped."""
    by_id = {s['id']: s['content'] for s in srcs}
    dropped, grounded = 0, []
    for t_index, topic in enumerate(topics, 1):
        topic = dict(topic)
        topic['id'] = f't{t_index}'
        kept = []
        for r_index, rule in enumerate(topic.get('rules') or [], 1):
            rule = dict(rule)
            text = by_id.get(rule.get('sourceId'), '')
            if not quotes.found(rule.get('quote', ''), text):
                dropped += 1
                continue
            rule['id'] = f'{topic["id"]}r{r_index}'
            kept.append(rule)
        topic['rules'] = kept
        grounded.append(topic)
    return grounded, dropped


def _parse_topics(value: dict, dialogues: list[dict]) -> dict:
    topics = value.get('topics')
    if not isinstance(topics, list) or not topics:
        raise ValueError('expected business topics')
    assignments = []
    for topic in topics:
        if not isinstance(topic, dict) or not isinstance(topic.get('title'), str) or not topic['title'].strip():
            raise ValueError('topic needs a title')
        if not isinstance(topic.get('rules'), list) or not isinstance(topic.get('dialogueIds'), list):
            raise ValueError('topic needs criteria and conversation assignments')
        for rule in topic['rules']:
            if not isinstance(rule, dict) or rule.get('observation') not in OBSERVATIONS:
                raise ValueError('criterion needs a supported observation')
            for field in ('text', 'sourceId', 'quote', 'condition', 'acceptable'):
                if not isinstance(rule.get(field), str):
                    raise ValueError(f'criterion needs {field}')
            if not rule['text'].strip() or not rule['sourceId'].strip() or not rule['quote'].strip():
                raise ValueError('criterion needs text and source evidence')
        assignments.extend(topic['dialogueIds'])
    expected = set(short_ids(dialogues))
    if not all(isinstance(item, str) for item in assignments):
        raise ValueError('conversation assignment must be an ID')
    if len(assignments) != len(expected) or set(assignments) != expected:
        raise ValueError('assign every conversation exactly once')
    return value


async def plan_topics(srcs: list[dict], dialogues: list[dict]) -> tuple[list[dict], int]:
    """New topics and rules from the sources; every sampled conversation is put into one topic."""

    payload = {'task': TASK, 'sources': srcs, 'dialogues': requests(dialogues)}
    answer = await llm.structured(PLAN, payload, parse=lambda value: _parse_topics(value, dialogues))
    plan = answer.value
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
        real, ids = short_ids(new), {t['id'] for t in topics}

        def parse(value: dict) -> dict:
            assignments = value.get('assignments')
            if not isinstance(assignments, list) or len(assignments) != len(real):
                raise ValueError('assign every new conversation exactly once')
            seen = set()
            for assignment in assignments:
                if not isinstance(assignment, dict):
                    raise ValueError('invalid conversation assignment')
                dialogue_id, topic_id = assignment.get('dialogueId'), assignment.get('topicId')
                if not isinstance(dialogue_id, str) or dialogue_id not in real or dialogue_id in seen:
                    raise ValueError('unknown or duplicated conversation assignment')
                if not isinstance(topic_id, str) or topic_id not in ids:
                    raise ValueError('unknown topic assignment')
                seen.add(dialogue_id)
            return value

        answer = await llm.structured(ASSIGN, payload, parse=parse)
        value = answer.value
        for a in value['assignments']:
            if a.get('topicId') in ids and str(a.get('dialogueId')) in real:
                known[real[str(a['dialogueId'])]] = a['topicId']
    for topic in topics:
        topic['dialogueIds'] = [str(d['id']) for d in dialogues if known.get(str(d['id'])) == topic['id']]
    return topics


async def judge_dialogue(dialogue: dict, topic: dict) -> dict:
    rules, shown = topic['rules'], conversation(dialogue)
    try:
        verdict = await judge.log_verdict(rules, shown)
        rows, status, model = verdict.rows, verdict.status, verdict.model
        second, error = await judge.second_opinion(judge.log_verdict, rules, shown), None
    except llm.ModelError as exc:
        rows = judge.checked([], rules, '')
        status, second, error, model = judge.verdict_of(rows), None, str(exc), None
    result = {
        'dialogueId': dialogue['id'],
        'topicId': topic['id'],
        'status': status,
        'rules': rows,
        'second': second,
        'opening': dialogue['messages'][0]['content'],
        'error': error,
        'model': model,
    }
    return result


async def judge_each(todo: list[tuple[dict, dict]], done: Callable[[dict], None]) -> None:
    """Judge conversations a few at a time, each with both checks, so the count moves from the first seconds.
    All at once, the model gate would run every first check before any second one and the count would wait minutes."""
    slots = asyncio.Semaphore(llm.CONCURRENCY)

    async def one(dialogue: dict, topic: dict) -> None:
        async with slots:
            result = await judge_dialogue(dialogue, topic)
        done(result)

    async with asyncio.TaskGroup() as tasks:
        for dialogue, topic in todo:
            tasks.create_task(one(dialogue, topic))


def ensure_answered(results: list[dict], previous: dict | None) -> None:
    """An outage is not a result: when the model answered on no conversation, the check fails, and its previous result
    (previous, the check's own), the scenarios built from it and the history stay. When only some failed, it is a
    result: those conversations are «не удалось проверить»."""
    if all(result['status'] == 'UNMEASURED' for result in results) and any(result.get('error') for result in results):
        kept = ' Прежний итог сохранён.' if previous else ''
        raise RuntimeError(f'{UNANSWERED}{kept} Проверьте модель в разделе «Настройки».')


def carry_reviews(previous: dict, results: list[dict]) -> None:
    """A person's decision stays with a verdict that did not change: the same conversation, rule and status.
    Only with frozen rules: extracted anew, the same rule id may be another rule."""
    kept = {
        (str(result['dialogueId']), row['ruleId'], row['status']): row['review']
        for result in previous.get('results') or []
        for row in result.get('rules') or []
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
                }
            )
    for item in patterns.values():
        item['count'] = len(item['dialogues'])
        item['topic'] = ', '.join(item['topics'])
    decided = ('PASS', 'FAIL')
    twice = [r for r in results if r['status'] in decided and (r.get('second') or {}).get('status') in decided]
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
    # The criteria come from the previous result, else from the ones a new export kept (checks.CODE_CRITERIA).
    result_before = store.load(RESULT) or {}
    previous = result_before or store.load(checks.CODE_CRITERIA) or {}
    # The tone-of-voice policy (tone.KIND) has its own check and result in tone.py; the rules here come from the
    # agent's code.
    srcs = [source for source in sources.load() if source['kind'] != TONE]
    if not srcs:
        raise RuntimeError('Код агента ещё не прочитан. Прочитайте его в разделе «Агент».')
    dialogues = sample(count)
    if not dialogues:
        raise RuntimeError('Нет разговоров для проверки. Сначала загрузите диалоги.')
    started = store.now()
    if previous.get('topics') and not replan:
        progress(stage='plan', done=0, total=len(dialogues), message='Распределяем разговоры по темам')
        topics = await keep_topics(previous, dialogues)
        dropped = previous.get('droppedRules', 0)
        rules_since = previous.get('rulesSince') or previous.get('startedAt')
    else:
        progress(stage='plan', done=0, total=len(dialogues), message='Извлекаем критерии из кода агента')
        topics, dropped = await plan_topics(srcs, dialogues)
        rules_since = started

    topic_of = {}
    for topic in topics:
        for dialogue_id in topic['dialogueIds']:
            topic_of.setdefault(dialogue_id, topic)
    todo = [(d, topic_of[str(d['id'])]) for d in dialogues if str(d['id']) in topic_of]
    progress(stage='judge', done=0, total=len(todo), message='Проверяем разговоры')
    results = []

    def done(result: dict) -> None:
        results.append(result)
        progress(stage='judge', done=len(results), total=len(todo), message='Проверяем разговоры')

    await judge_each(todo, done)
    ensure_answered(results, result_before)
    order = {str(d['id']): i for i, d in enumerate(dialogues)}
    results.sort(key=lambda r: order.get(str(r['dialogueId']), 0))
    if previous.get('topics') and not replan:
        carry_reviews(previous, results)
    rule_count = Counter(rule.get('sourceId') for topic in topics for rule in topic['rules'])
    value = {
        # The check's own id and the conversations it judged: its record in the history (accuracy_history.commit).
        'checkId': uuid.uuid4().hex,
        'datasetFingerprint': history.dataset_fingerprint([dialogue for dialogue, _ in todo]),
        'startedAt': started,
        'finishedAt': store.now(),
        'model': llm.models_used(results),
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
    return value
