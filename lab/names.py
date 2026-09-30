"""Short names of the criteria: two to five words a person reads at a glance, over the rule's full sentence.

New criteria get their names when they are extracted (prompts.PLAN). This names the ones extracted before that,
in one request, and writes the names next to the rules in the log assessment and in the scenario deck.
"""

from collections.abc import Callable

from . import cards, discover, llm, quotes, store
from .prompts import NAMES


def missing() -> list[dict]:
    """The rules without a name, once per rule (by the quote they are grounded in)."""
    seen: dict[str, dict] = {}
    for topic in (store.load(discover.RESULT) or {}).get('topics') or []:
        for rule in topic['rules']:
            if not rule.get('name'):
                seen.setdefault(quotes.normalized(rule['quote']), rule)
    for card in cards.deck():
        for rule in card.get('criteria') or []:
            if not rule.get('name'):
                seen.setdefault(quotes.normalized(rule['quote']), rule)
    return list(seen.values())


async def run(progress: Callable[..., None] = lambda **_: None) -> dict:
    rules = missing()
    if not rules:
        return {'named': 0}
    progress(message=f'Придумываю имена для {len(rules)} критериев')
    ids = {f'r{i}': quotes.normalized(r['quote']) for i, r in enumerate(rules, 1)}
    payload = {
        'rules': [
            {'id': f'r{i}', 'text': r['text'], 'condition': r.get('condition', '')} for i, r in enumerate(rules, 1)
        ]
    }

    def check(value: dict) -> None:
        got = {n.get('id') for n in value.get('names') or [] if str(n.get('name') or '').strip()}
        if got != set(ids):
            raise ValueError('not every rule is named')

    value = await llm.structured(NAMES, payload, check=check)
    by_quote = {ids[n['id']]: str(n['name']).strip().rstrip('.') for n in value['names']}

    def name(rule: dict) -> None:
        if not rule.get('name'):
            rule['name'] = by_quote.get(quotes.normalized(rule['quote']), '')

    analysis = store.load(discover.RESULT)
    if analysis:
        for topic in analysis.get('topics') or []:
            for rule in topic['rules']:
                name(rule)
        store.save(discover.RESULT, analysis)
    deck = store.load(cards.DECK)
    if deck:
        for card in deck.get('cards') or []:
            for rule in card.get('criteria') or []:
                name(rule)
        store.save(cards.DECK, deck)
    return {'named': len(by_quote)}
