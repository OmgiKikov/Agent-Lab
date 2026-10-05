"""Test cards: business scenarios built from the errors one check found in the real conversations.

A card is a situation for the synthetic customer (taken from a real conversation), its frozen criteria
(the grounded rules of its topic, observable in the agent's replies or its system calls) and its test data
for the mocked bank systems. A card from an error names the criteria the agent failed in that conversation
(reproduces): the scenario is a test of that error. The deck names the check it was built from (checks.py).
"""

import asyncio
import hashlib
import json
from collections.abc import Callable, Sequence

from . import checks, llm, logs, quotes, store, tone
from .agents import world
from .context import sources
from .prompts import CARD

DECK = checks.DECK
LIMIT = 30
PER_ERROR = 2  # conversations per criterion the agent failed, and controls per topic
# Why a card exists: an error the check found in a real conversation, or a conversation without one (a control).
FROM_LOG, COVERAGE = 'Ошибка из лога', 'Покрытие темы'
# What the task says while it builds; the count of the built and the failed ones is the task's own (done of total).
BUILDING = 'Собираем сценарии'
# Applies to every scenario: instructions must come from the knowledge base, not be invented.
FOLLOWS_KNOWLEDGE = {
    'id': 'g-knowledge',
    'name': 'Не выдумывает инструкции',
    'text': (
        'Ответ агента опирается на статьи базы знаний: шаги, разделы, сроки и условия совпадают со статьёй '
        'и не выдуманы.'
    ),
    'condition': 'Когда агент даёт инструкцию или сообщает факты.',
    'acceptable': 'Уточняющий вопрос. Или «Не могу помочь, информация отсутствует», если в статьях нет ответа.',
    'quote': 'Используй ТОЛЬКО информацию из контекста.',
    'observation': 'knowledge',
}
# Applies to every scenario: the agent must answer the question that was asked.
ANSWERS_THE_QUESTION = {
    'id': 'g-answer',
    'name': 'Отвечает на заданный вопрос',
    'text': (
        'Каждый ответ агента по существу вопроса клиента: инструкция именно для его задачи '
        'или уточнение недостающего, без ответов на другую тему.'
    ),
    'condition': 'Всегда, когда агент отвечает клиенту.',
    'acceptable': (
        'Уточняющий вопрос по существу. Или «Не могу помочь, информация отсутствует», если ответа действительно нет.'
    ),
    'quote': 'Твоя главная задача — найти и чётко выдать инструкции для самостоятельного выполнения клиентом',
}


def deck() -> list[dict]:
    return (store.load(DECK) or {}).get('cards') or []


def check() -> str | None:
    """The check whose errors the deck was built from."""
    return (store.load(DECK) or {}).get('check')


def remember_openings(openings: dict[str, dict[str, str]]) -> None:
    """Keep the openings rewritten for customer types (simulate.prepare_openings) in the cards."""
    value = store.load(DECK) or {}
    for card in value.get('cards') or []:
        card.setdefault('openings', {}).update(openings.get(card['id'], {}))
    store.save(DECK, value)


def _parse_card(value: dict) -> dict:
    for field in ('name', 'situation'):
        if not isinstance(value.get(field), str) or not value[field].strip():
            raise ValueError(f'card needs {field}')
    return value


def failed_in(result: dict) -> list[str]:
    """The criteria the agent failed in one conversation of a check's result, in the order of its verdicts."""
    return [row['ruleId'] for row in result.get('rules') or [] if row.get('status') == 'FAIL' and row.get('ruleId')]


def pick(analysis: dict) -> list[tuple[dict, dict, str, list[str]]]:
    """The conversations to build scenarios from, with the criteria the agent failed in each. Per topic, every
    criterion the agent failed gets its own conversation, the most frequent error first, then a conversation without
    an error (a control); then every criterion its second conversation, then the second control. A conversation is
    used once and keeps every criterion it failed. The rounds run across all topics, so a cut at LIMIT keeps one
    scenario per error before any second one: tone of voice, one topic, was capped at two errors and two controls."""
    by_id = {str(d['id']): d for d in logs.load()}
    topics = []
    for topic in analysis['topics']:
        if not any(r['observation'] == 'reply' for r in topic['rules']):
            continue
        results = [r for r in analysis['results'] if r['topicId'] == topic['id'] and str(r['dialogueId']) in by_id]
        failing = {
            rule['id']: [r for r in results if r['status'] == 'FAIL' and rule['id'] in failed_in(r)]
            for rule in topic['rules']
            if rule['observation'] in ('reply', 'tool')
        }
        ordered = sorted((found for found in failing.values() if found), key=len, reverse=True)
        # A conversation checked without an error first; one the model could not check only when none is left.
        controls = [r for status in ('PASS', 'UNMEASURED') for r in results if r['status'] == status]
        topics.append((topic, ordered, controls))
    used: set[str] = set()
    picked = []
    for n in range(PER_ERROR):
        for topic, ordered, _ in topics:
            for found in ordered:
                result = next((r for r in found if str(r['dialogueId']) not in used), None)
                if result is not None:
                    used.add(str(result['dialogueId']))
                    picked.append((topic, by_id[str(result['dialogueId'])], FROM_LOG, failed_in(result)))
        for topic, _, controls in topics:
            if n < len(controls):
                picked.append((topic, by_id[str(controls[n]['dialogueId'])], COVERAGE, []))
    return picked[:LIMIT]


def general_rules(analysis: dict) -> list[dict]:
    """Rules the planner attached to three or more topics: they apply to every scenario."""
    by_quote = {}
    for topic in analysis['topics']:
        for rule in topic['rules']:
            if rule['observation'] == 'reply':
                by_quote.setdefault(quotes.normalized(rule['quote']), []).append((topic['id'], rule))
    return [items[0][1] for items in by_quote.values() if len({t for t, _ in items}) >= 3]


async def build_card(
    topic: dict, dialogue: dict, origin: str, general: Sequence[dict] = (), reproduces: Sequence[str] = ()
) -> dict:
    """The card of one conversation. reproduces: the criteria the agent failed in it (pick); the card keeps the ones
    it checks, so a criterion the scenario cannot observe is never said to be reproduced by it."""
    customer = [m['content'] for m in dialogue['messages'] if m['role'] == 'user']
    answer = await llm.structured(CARD, {'topic': topic['title'], 'customerMessages': customer}, parse=_parse_card)
    value = answer.value
    rules = [r for r in topic['rules'] if r['observation'] in ('reply', 'tool')]
    seen = {quotes.normalized(r['quote']) for r in rules}
    rules += [r for r in general if quotes.normalized(r['quote']) not in seen]
    prompts = '\n'.join(source['content'] for source in sources.load())
    rules += [rule for rule in (ANSWERS_THE_QUESTION, FOLLOWS_KNOWLEDGE) if quotes.found(rule['quote'], prompts)]
    rules = [tone.for_judging(rule) for rule in rules]
    criteria = [
        {
            'id': r['id'],
            'name': r.get('name', ''),
            'text': r['text'],
            'condition': r.get('condition', ''),
            'acceptable': r.get('acceptable', ''),
            'quote': r['quote'],
            'observation': r.get('observation', 'reply'),
            **({'clarifications': list(r['clarifications'])} if r.get('clarifications') else {}),
        }
        for r in rules
    ]
    try:
        test_data = await world.build(value['situation'], customer)
    except llm.ModelError:
        test_data = None
    checked = {criterion['id'] for criterion in criteria}
    card = {
        'topic': topic['title'],
        'topicId': topic['id'],
        'name': value['name'].strip(),
        'situation': value['situation'].strip(),
        'opening': customer[0],
        'criteria': criteria,
        'origin': origin,
        'sourceDialogueId': str(dialogue['id']),
        'reproduces': list(dict.fromkeys(rule_id for rule_id in reproduces if rule_id in checked)),
        'world': test_data,
    }
    card['id'] = hashlib.sha256(json.dumps(card, ensure_ascii=False, sort_keys=True).encode()).hexdigest()[:12]
    card['model'] = answer.model
    return card


async def run(check: str, progress: Callable[..., None] = lambda **_: None) -> list[dict]:
    """The cards built from the conversations picked in the check's result. A card the model fails to build is
    reported in the progress (failed) and never cancels the others; only when no card is built is the build an error."""
    analysis = store.load(checks.result(check))
    if not analysis:
        raise RuntimeError(f'У проверки «{checks.NAMES[check]}» ещё нет итога. Сначала проверьте разговоры.')
    if check == checks.TONE:
        draft = store.load(tone.DRAFT) or {}
        if draft.get('revision') != analysis.get('criteriaRevision'):
            raise RuntimeError(
                'Критерии tone of voice изменились. Сначала проверьте разговоры заново, потом соберите сценарии.'
            )
    picks = pick(analysis)
    if not picks:
        raise RuntimeError('Нет разговоров, из которых можно собрать сценарии.')
    general = general_rules(analysis)
    built: dict[int, dict] = {}
    failed: list[dict] = []

    async def one(index: int, topic: dict, dialogue: dict, origin: str, reproduces: Sequence[str] = ()) -> None:
        try:
            built[index] = await build_card(topic, dialogue, origin, general, reproduces)
        except llm.ModelError as error:
            failed.append({'topic': topic['title'], 'dialogueId': str(dialogue['id']), 'error': str(error)})
        missing = f'. Не удалось собрать: {len(failed)}' if failed else ''
        progress(
            stage='cards',
            done=len(built) + len(failed),
            total=len(picks),
            message=f'{BUILDING}{missing}',
            failed=list(failed),
        )

    progress(stage='cards', done=0, total=len(picks), message=BUILDING)
    async with asyncio.TaskGroup() as tasks:
        for index, chosen in enumerate(picks):
            tasks.create_task(one(index, *chosen))
    if not built:
        raise llm.ModelError(failed[0]['error'])
    return [built[index] for index in sorted(built)]
