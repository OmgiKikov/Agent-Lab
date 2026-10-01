"""The one quality number and how far it can be trusted.

Accuracy = conversations where the agent met every applicable criterion / measured conversations.
"Not measured" (no client answer, or no evidence either way) never counts as a pass or a failure.
Trust: agreement of the second judge, stability of a scenario across its repeats, a person's decisions on verdicts.
With several customer types, accuracy per type shows where the agent breaks on how people write.
"""

from .personas import DEFAULT

FINISHED = ('PASS', 'FAIL', 'UNMEASURED')


def _accuracy(statuses: list[str]) -> dict:
    passed, failed = statuses.count('PASS'), statuses.count('FAIL')
    measured = passed + failed
    return {'accuracy': round(100 * passed / measured) if measured else None, 'passed': passed, 'measured': measured}


def _decisions(item: dict) -> list[str]:
    """A person's decisions on the conversation's verdicts, or on the conversation as a whole in older records."""
    rows = [r['review'] for r in item.get('rules') or [] if r.get('review') in ('agree', 'disagree')]
    return rows or ([item['review']] if item.get('review') in ('agree', 'disagree') else [])


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
    twice = [i for i in done if (i.get('second') or {}).get('status') in FINISHED]
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
    decisions = [d for i in done for d in _decisions(i)]
    if decisions:
        value['human'] = {'reviewed': len(decisions), 'agree': decisions.count('agree')}
    return value
