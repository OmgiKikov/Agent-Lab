"""Step 2: business scenario cards built from evaluated logs.

A card = situation for the synthetic customer (from a real conversation) +
frozen criteria (the grounded owner rules of its topic that are observable in replies).
"""
import asyncio
import hashlib
import json

from . import discover, llm, store, world
from .prompts import CARD

LIMIT = 30
# Applies to every scenario: the agent must answer the question that was asked.
ANSWERS_THE_QUESTION = {
    'id': 'g-answer',
    'text': 'Агент отвечает по существу вопроса клиента: даёт инструкцию именно для его задачи или уточняет недостающее, а не отвечает на другую тему.',
    'condition': 'Всегда, когда агент отвечает клиенту.',
    'acceptable': 'Уточняющий вопрос по существу; «Не могу помочь, информация отсутствует», если ответа действительно нет.',
    'quote': 'Твоя главная задача — найти и чётко выдать инструкции для самостоятельного выполнения клиентом',
}


def _check(value: dict) -> None:
    if not str(value.get('name') or '').strip() or not str(value.get('situation') or '').strip():
        raise ValueError('empty card')


def pick(analysis: dict) -> list[tuple[dict, dict, str]]:
    """Per topic: up to two conversations where the agent failed (regressions) and two where it did not (coverage)."""
    by_id = {str(d['id']): d for d in discover.logs()}
    rounds = [[], [], [], []]  # 1st regression, 1st coverage, 2nd regression, 2nd coverage of every topic
    for topic in analysis['topics']:
        if not any(r['observation'] == 'reply' for r in topic['rules']):
            continue
        results = [r for r in analysis['results'] if r['topicId'] == topic['id'] and str(r['dialogueId']) in by_id]
        failed = [r for r in results if r['status'] == 'FAIL']
        passed = [r for r in results if r['status'] == 'PASS']
        for n in range(2):
            if n < len(failed):
                rounds[2 * n].append((topic, by_id[str(failed[n]['dialogueId'])], 'Ошибка из лога'))
            if n < len(passed):
                rounds[2 * n + 1].append((topic, by_id[str(passed[n]['dialogueId'])], 'Покрытие темы'))
    return [pick for group in rounds for pick in group][:LIMIT]


def general_rules(analysis: dict) -> list[dict]:
    """Owner rules that the planner attached to 3+ topics: they apply to every scenario."""
    by_quote = {}
    for topic in analysis['topics']:
        for rule in topic['rules']:
            if rule['observation'] == 'reply':
                by_quote.setdefault(store.normalized(rule['quote']), []).append((topic['id'], rule))
    return [items[0][1] for items in by_quote.values() if len({t for t, _ in items}) >= 3]


async def build_card(topic: dict, dialogue: dict, origin: str, general: list[dict] = ()) -> dict:
    customer = [m['content'] for m in dialogue['messages'] if m['role'] == 'user']
    value = await llm.structured(CARD, {'topic': topic['title'], 'customerMessages': customer}, check=_check)
    rules = [r for r in topic['rules'] if r['observation'] == 'reply']
    quotes = {store.normalized(r['quote']) for r in rules}
    rules += [r for r in general if store.normalized(r['quote']) not in quotes]
    owner = '\n'.join(src['content'] for src in discover.sources())
    if store.quote_found(ANSWERS_THE_QUESTION['quote'], owner):
        rules.append(ANSWERS_THE_QUESTION)
    criteria = [{'id': r['id'], 'text': r['text'], 'condition': r.get('condition', ''),
                 'acceptable': r.get('acceptable', ''), 'quote': r['quote']} for r in rules]
    try:
        scenario_world = await world.build(value['situation'], customer)
    except llm.ModelError:
        scenario_world = None
    card = {'topic': topic['title'], 'topicId': topic['id'], 'name': value['name'].strip(),
            'situation': value['situation'].strip(), 'opening': customer[0], 'criteria': criteria,
            'origin': origin, 'sourceDialogueId': str(dialogue['id']), 'world': scenario_world}
    card['id'] = hashlib.sha256(json.dumps(card, ensure_ascii=False, sort_keys=True).encode()).hexdigest()[:12]
    return card


async def run(progress=lambda **_: None) -> list[dict]:
    analysis = store.load('discover.json')
    if not analysis:
        raise RuntimeError('Сначала оцените логи')
    picks = pick(analysis)
    general = general_rules(analysis)
    done = []

    async def one(item):
        try:
            card = await build_card(*item, general)
        except llm.ModelError:
            card = None
        done.append(card)
        progress(stage='cards', done=len(done), total=len(picks), message=f'Готово сценариев: {len(done)} из {len(picks)}')
        return card

    progress(stage='cards', done=0, total=len(picks), message='Собираю сценарии')
    cards = [c for c in await asyncio.gather(*(one(p) for p in picks)) if c]
    store.save('cards.json', {'createdAt': store.now(), 'model': llm.model_label, 'cards': cards})
    return cards
