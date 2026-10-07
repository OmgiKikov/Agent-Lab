"""The Lab's own instruments, measured by what it keeps (python -m lab.eval): how often people agree with the judge,
and how the calls to the models went. Pure functions over the answers and over the journal of calls.

The answers measure the judge, whatever the agent: a version of its instructions people agree with less is a worse
judge. Only a person's own answer on a verdict counts (flows.evaluation.answered).
"""

from collections.abc import Iterable

from .statistics import FEW, wilson

# How a call ended (models.chat): answered, an answer nobody could use, refused by the model, or failed.
OUTCOMES = ('answered', 'unusable', 'refused', 'failed')


def agreement(answers: Iterable[dict]) -> list[dict]:
    """The answers by role of the judge, version of its instructions and check, the most answered first within a role:
    how many verdicts people answered, how many they agreed with, the share and where it may lie (statistics.wilson);
    apart, the errors the judge found (FAIL) and its verdicts «без ошибки» (PASS), each confirmed of answered. few:
    fewer answers than statistics.FEW, the share says little yet. answers: {role, version, check, status, decision}."""
    groups: dict[tuple, dict] = {}
    for answer in answers:
        key = (answer['role'], answer.get('version'), answer.get('check'))
        group = groups.setdefault(key, {'answered': 0, 'agreed': 0, 'errors': [0, 0], 'clean': [0, 0]})
        agreed = answer['decision'] == 'agree'
        group['answered'] += 1
        group['agreed'] += agreed
        side = {'FAIL': 'errors', 'PASS': 'clean'}.get(answer.get('status'))
        if side:
            group[side][0] += agreed
            group[side][1] += 1
    rows = [
        {
            'role': role,
            'version': version,
            'check': check,
            'answered': group['answered'],
            'agreed': group['agreed'],
            'share': group['agreed'] / group['answered'],
            'interval': wilson(group['agreed'], group['answered']),
            'errors': {'confirmed': group['errors'][0], 'answered': group['errors'][1]},
            'clean': {'confirmed': group['clean'][0], 'answered': group['clean'][1]},
            'few': group['answered'] < FEW,
        }
        for (role, version, check), group in groups.items()
    ]
    return sorted(rows, key=lambda row: (row['role'], -row['answered'], str(row['version']), str(row['check'])))


def usage(calls: Iterable[dict]) -> list[dict]:
    """The calls to the models by role, version of its instructions and model asked, the most frequent first: the tries,
    how they ended (OUTCOMES), the median time of one, the tokens, and the cost of the calls whose model named it
    (priced: how many). calls: the journal's lines (storage.calls)."""
    groups: dict[tuple, dict] = {}
    for call in calls:
        key = (call.get('role'), call.get('version'), call.get('model'))
        group = groups.setdefault(
            key, {'outcomes': dict.fromkeys(OUTCOMES, 0), 'ms': [], 'input': 0, 'output': 0, 'cost': 0.0, 'priced': 0}
        )
        outcome = call.get('outcome')
        group['outcomes'][outcome] = group['outcomes'].get(outcome, 0) + 1
        group['ms'].append(call.get('ms') or 0)
        group['input'] += call.get('inputTokens') or 0
        group['output'] += call.get('outputTokens') or 0
        if call.get('cost') is not None:
            group['cost'] += call['cost']
            group['priced'] += 1
    rows = [
        {
            'role': role,
            'version': version,
            'model': model,
            'calls': len(group['ms']),
            'outcomes': group['outcomes'],
            'medianMs': _median(group['ms']),
            'inputTokens': group['input'],
            'outputTokens': group['output'],
            'cost': round(group['cost'], 6) if group['priced'] else None,
            'priced': group['priced'],
        }
        for (role, version, model), group in groups.items()
    ]
    return sorted(rows, key=lambda row: (-row['calls'], str(row['role']), str(row['version']), str(row['model'])))


def _median(values: list[int]) -> float:
    ordered = sorted(values)
    middle = len(ordered) // 2
    return float(ordered[middle]) if len(ordered) % 2 else (ordered[middle - 1] + ordered[middle]) / 2
