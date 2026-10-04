"""Each scenario of the deck as a test (docs/superpowers/specs/2026-10-03-scenario-cards-design.md): the error of the
real conversation it reproduces, and its own result in every run of the deck's check, newest run first.

Only read, no model is called. The results of a scenario are observations side by side, one per run: nothing here
says whether the agent got better or worse.
"""

from . import cards, checks, personas, store
from .metric import FINISHED


def _named(criterion: dict, fallback: str) -> str:
    """A criterion's short name; one without a name is named by what it requires."""
    return (criterion.get('name') or '').strip() or criterion.get('text') or fallback


def reproduced(card: dict, source: dict | None) -> list[dict]:
    """The criteria the scenario reproduces, with the agent's words from its real conversation (source: that
    conversation in the current result of the deck's check). A card built before cards named them reproduces what its
    conversation failed in that result, when it came from an error. The words come only from a verdict that is still
    an error there."""
    criteria = {criterion['id']: criterion for criterion in card.get('criteria') or []}
    rows = {row.get('ruleId'): row for row in (source or {}).get('rules') or []}
    if 'reproduces' in card:
        ids = card['reproduces']
    elif card.get('origin') == cards.FROM_LOG and source:
        ids = [rule_id for rule_id in cards.failed_in(source) if rule_id in criteria]
    else:
        ids = []
    found = []
    for rule_id in ids:
        criterion, row = criteria.get(rule_id) or {}, rows.get(rule_id) or {}
        found.append(
            {
                'ruleId': rule_id,
                'name': _named(criterion, row.get('rule') or rule_id),
                'text': criterion.get('text') or row.get('rule', ''),
                'agentQuote': row.get('agentQuote', '') if row.get('status') == 'FAIL' else '',
            }
        )
    return found


def played(runs: list[dict], ids: set[str]) -> dict[str, list[dict]]:
    """Every finished conversation of each scenario in the runs given (newest first): which run, who played it, its
    result, the criteria it failed, and where it is in its run (index). One still playing has no result yet."""
    history: dict[str, list[dict]] = {card_id: [] for card_id in ids}
    for record in runs:
        for index, item in enumerate(record.get('items') or []):
            if item.get('cardId') not in history or item.get('status') not in FINISHED:
                continue
            frozen = item.get('criteria') if isinstance(item.get('criteria'), list) else []
            criteria = {criterion['id']: criterion for criterion in frozen}
            failed = [
                {'ruleId': row['ruleId'], 'name': _named(criteria.get(row['ruleId']) or {}, row.get('rule', ''))}
                for row in item.get('rules') or []
                if row.get('status') == 'FAIL' and row.get('ruleId')
            ]
            history[item['cardId']].append(
                {
                    'run': record['id'],
                    'label': record.get('label') or '',
                    'startedAt': record.get('startedAt'),
                    'persona': item.get('persona') or personas.DEFAULT,
                    'attempt': item.get('attempt', 1),
                    'status': item['status'],
                    'index': index,
                    'failed': failed,
                }
            )
    return history


def build() -> dict:
    """The scenarios of the deck: {check, cards: [{id, sourceStatus, reproduces, history}]}, in the deck's order."""
    document = store.load(cards.DECK) or {}
    deck = document.get('cards') or []
    check = document.get('check')
    analysis = (store.load(checks.result(check)) if check in checks.RESULTS else None) or {}
    sources = {str(result.get('dialogueId')): result for result in analysis.get('results') or []}
    # Every run of the deck's check is read in full, its conversations included: the results of a scenario are spread
    # over the items of all of them, and a run's summary has no items. Fine for a Lab of tens of runs; reading is free.
    runs = [record for record in store.runs() if check is None or checks.of_run(record) == check]
    history = played(runs, {card['id'] for card in deck})
    listed = []
    for card in deck:
        source = sources.get(str(card.get('sourceDialogueId')))
        listed.append(
            {
                'id': card['id'],
                'sourceStatus': (source or {}).get('status'),
                'reproduces': reproduced(card, source),
                'history': history[card['id']],
            }
        )
    return {'check': check, 'cards': listed}
