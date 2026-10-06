"""The one quality number and how far it can be trusted.

Accuracy = conversations where the agent met every applicable criterion / measured conversations.
"Not measured" (no client answer, or no evidence either way) never counts as a pass or a failure.
Trust: agreement of the second judge, stability of a scenario across its repeats, and a person's decisions on verdicts,
kept apart from them and counted when the run is read (answers.human).
With several customer types, accuracy per type shows where the agent breaks on how people write.
Scenario sets (representative, regression, stress) each get their own accuracy; the representative one also weighted
by how many conversations of the export each card stands for, its estimate for the export.
"""

from .personas import DEFAULT

FINISHED = ('PASS', 'FAIL', 'UNMEASURED')
DECIDED = ('PASS', 'FAIL')


def _accuracy(statuses: list[str]) -> dict:
    passed, failed = statuses.count('PASS'), statuses.count('FAIL')
    measured = passed + failed
    return {'accuracy': round(100 * passed / measured) if measured else None, 'passed': passed, 'measured': measured}


def metric(items: list[dict]) -> dict:
    done = [i for i in items if i.get('status') in FINISHED]
    passed = sum(1 for i in done if i['status'] == 'PASS')
    failed = sum(1 for i in done if i['status'] == 'FAIL')
    measured = passed + failed
    value = {
        'accuracy': round(100 * passed / measured) if measured else None,
        'passed': passed,
        'failed': failed,
        'unmeasured': len(done) - measured,
        'measured': measured,
        'total': len(done),
    }
    # As results.summarize: a check that decided nothing is no second opinion, so it neither agrees nor disagrees.
    twice = [i for i in done if i['status'] in DECIDED and (i.get('second') or {}).get('status') in DECIDED]
    if twice:
        value['secondJudge'] = {
            'model': twice[0]['second'].get('model'),
            'checked': len(twice),
            'agree': sum(1 for i in twice if i['second']['status'] == i['status']),
        }
    # Repeats of one scenario played by one customer type.
    by_case: dict[tuple[str, str], list[str]] = {}
    for item in done:
        by_case.setdefault((item['cardId'], item.get('persona') or DEFAULT), []).append(item['status'])
    repeated = [statuses for statuses in by_case.values() if len(statuses) > 1]
    if repeated:
        value['repeats'] = {
            'scenarios': len(repeated),
            'stable': sum(1 for statuses in repeated if len(set(statuses)) == 1),
            'attempts': max(len(statuses) for statuses in repeated),
        }
    by_persona: dict[str, list[str]] = {}
    for item in done:
        by_persona.setdefault(item.get('persona') or DEFAULT, []).append(item['status'])
    if len(by_persona) > 1:
        value['personas'] = {key: _accuracy(statuses) for key, statuses in by_persona.items()}
    # Scenario sets answer different questions and are never averaged: each gets its own number.
    by_set: dict[str, list[dict]] = {}
    for item in done:
        for key in item.get('sets') or []:
            by_set.setdefault(key, []).append(item)
    if by_set:
        value['sets'] = {key: _accuracy([i['status'] for i in found]) for key, found in by_set.items()}
        representative = by_set.get('representative', [])
        sampled = [i for i in representative if i.get('weight')]
        if sampled and len(sampled) == len(representative):
            measured_weight = sum(i['weight'] for i in sampled if i['status'] in DECIDED)
            passed_weight = sum(i['weight'] for i in sampled if i['status'] == 'PASS')
            value['sets']['representative']['weighted'] = (
                round(100 * passed_weight / measured_weight) if measured_weight else None
            )
        elif representative:
            # A scenario of the sample has no card (deck: catalog.weighted): the rest would not stand for the export.
            value['sets']['representative']['incomplete'] = True
    return value
