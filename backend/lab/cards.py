"""Test cards: business scenarios built from the audited logs.

A card is a situation for the synthetic customer (taken from a real conversation), its frozen criteria
(the grounded rules of its topic, observable in the agent's replies or its system calls) and its test data
for the mocked bank systems.
"""

import asyncio
import hashlib
import json
from collections.abc import Callable, Sequence

from . import discover, llm, logs, quotes, store
from .agents import world
from .context import sources
from .prompts import CARD

DECK = 'cards.json'
LIMIT = 30
# Applies to every scenario: instructions must come from the knowledge base, not be invented.
FOLLOWS_KNOWLEDGE = {
    'id': 'g-knowledge',
    'text': (
        'Ответ агента опирается на статьи базы знаний: шаги, разделы, сроки и условия совпадают со статьёй '
        'и не выдуманы.'
    ),
    'condition': 'Когда агент даёт инструкцию или сообщает факты.',
    'acceptable': 'Уточняющий вопрос; «Не могу помочь, информация отсутствует», если в статьях нет ответа.',
    'quote': 'Используй ТОЛЬКО информацию из контекста.',
    'observation': 'knowledge',
}
# Applies to every scenario: the agent must answer the question that was asked.
ANSWERS_THE_QUESTION = {
    'id': 'g-answer',
    'text': (
        'Каждый ответ агента по существу вопроса клиента: инструкция именно для его задачи '
        'или уточнение недостающего, без ответов на другую тему.'
    ),
    'condition': 'Всегда, когда агент отвечает клиенту.',
    'acceptable': (
        'Уточняющий вопрос по существу; «Не могу помочь, информация отсутствует», если ответа действительно нет.'
    ),
    'quote': 'Твоя главная задача — найти и чётко выдать инструкции для самостоятельного выполнения клиентом',
}


def deck() -> list[dict]:
    return (store.load(DECK) or {}).get('cards') or []


def remember_openings(openings: dict[str, dict[str, str]]) -> None:
    """Keep the openings rewritten for customer types (simulate.prepare_openings) in the cards."""
    value = store.load(DECK) or {}
    for card in value.get('cards') or []:
        card.setdefault('openings', {}).update(openings.get(card['id'], {}))
    store.save(DECK, value)


def _check(value: dict) -> None:
    for field in ('name', 'situation'):
        if not isinstance(value.get(field), str) or not value[field].strip():
            raise ValueError(f'card needs {field}')


def pick(analysis: dict) -> list[tuple[dict, dict, str]]:
    """Per topic: up to two conversations where the agent failed (regressions) and two where it did not (coverage)."""
    by_id = {str(d['id']): d for d in logs.load()}
    rounds = [[], [], [], []]  # 1st regression, 1st coverage, 2nd regression, 2nd coverage of every topic
    for topic in analysis['topics']:
        if not any(r['observation'] == 'reply' for r in topic['rules']):
            continue
        results = [r for r in analysis['results'] if r['topicId'] == topic['id'] and str(r['dialogueId']) in by_id]
        failed = [r for r in results if r['status'] == 'FAIL']
        coverage = [r for r in results if r['status'] in ('PASS', 'UNMEASURED')]
        for n in range(2):
            if n < len(failed):
                rounds[2 * n].append((topic, by_id[str(failed[n]['dialogueId'])], 'Ошибка из лога'))
            if n < len(coverage):
                rounds[2 * n + 1].append((topic, by_id[str(coverage[n]['dialogueId'])], 'Покрытие темы'))
    return [chosen for group in rounds for chosen in group][:LIMIT]


def general_rules(analysis: dict) -> list[dict]:
    """Rules the planner attached to three or more topics: they apply to every scenario."""
    by_quote = {}
    for topic in analysis['topics']:
        for rule in topic['rules']:
            if rule['observation'] == 'reply':
                by_quote.setdefault(quotes.normalized(rule['quote']), []).append((topic['id'], rule))
    return [items[0][1] for items in by_quote.values() if len({t for t, _ in items}) >= 3]


async def build_card(topic: dict, dialogue: dict, origin: str, general: Sequence[dict] = ()) -> dict:
    customer = [m['content'] for m in dialogue['messages'] if m['role'] == 'user']
    answer = await llm.structured(CARD, {'topic': topic['title'], 'customerMessages': customer}, check=_check)
    value = answer.value
    rules = [r for r in topic['rules'] if r['observation'] in ('reply', 'tool')]
    seen = {quotes.normalized(r['quote']) for r in rules}
    rules += [r for r in general if quotes.normalized(r['quote']) not in seen]
    prompts = '\n'.join(source['content'] for source in sources.load())
    rules += [rule for rule in (ANSWERS_THE_QUESTION, FOLLOWS_KNOWLEDGE) if quotes.found(rule['quote'], prompts)]
    criteria = [
        {
            'id': r['id'],
            'text': r['text'],
            'condition': r.get('condition', ''),
            'acceptable': r.get('acceptable', ''),
            'quote': r['quote'],
            'observation': r.get('observation', 'reply'),
        }
        for r in rules
    ]
    try:
        test_data = await world.build(value['situation'], customer)
    except llm.ModelError:
        test_data = None
    card = {
        'topic': topic['title'],
        'topicId': topic['id'],
        'name': value['name'].strip(),
        'situation': value['situation'].strip(),
        'opening': customer[0],
        'criteria': criteria,
        'origin': origin,
        'sourceDialogueId': str(dialogue['id']),
        'world': test_data,
    }
    card['id'] = hashlib.sha256(json.dumps(card, ensure_ascii=False, sort_keys=True).encode()).hexdigest()[:12]
    card['model'] = answer.model
    return card


async def run(progress: Callable[..., None] = lambda **_: None) -> list[dict]:
    analysis = store.load(discover.RESULT)
    if not analysis:
        raise RuntimeError('Сначала оцените логи')
    picks = pick(analysis)
    if not picks:
        raise RuntimeError('Нет разговоров с проверяемыми правилами для сборки сценариев')
    general = general_rules(analysis)
    done = []

    async def one(topic: dict, dialogue: dict, origin: str) -> dict:
        card = await build_card(topic, dialogue, origin, general)
        done.append(card)
        progress(
            stage='cards', done=len(done), total=len(picks), message=f'Готово сценариев: {len(done)} из {len(picks)}'
        )
        return card

    progress(stage='cards', done=0, total=len(picks), message='Собираю сценарии')
    try:
        async with asyncio.TaskGroup() as tasks:
            pending = [tasks.create_task(one(*pick)) for pick in picks]
    except* llm.ModelError as errors:
        raise llm.ModelError(str(errors.exceptions[0])) from errors
    return [task.result() for task in pending]
