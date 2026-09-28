"""The one quality number and how far it can be trusted.

Accuracy = conversations where the agent met every applicable criterion / measured conversations.
"Not measured" (no client answer, or no evidence either way) never counts as a pass or a failure.
Trust: agreement of the second judge, stability of a scenario across its repeats, a person's review.
"""

FINISHED = ('PASS', 'FAIL', 'UNMEASURED')


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
    by_card: dict[str, list[str]] = {}
    for item in done:
        by_card.setdefault(item['cardId'], []).append(item['status'])
    repeated = [statuses for statuses in by_card.values() if len(statuses) > 1]
    if repeated:
        value['repeats'] = {
            'scenarios': len(repeated),
            'stable': sum(1 for statuses in repeated if len(set(statuses)) == 1),
            'attempts': max(len(statuses) for statuses in repeated),
        }
    reviewed = [i for i in done if i.get('review') in ('agree', 'disagree')]
    if reviewed:
        value['human'] = {'reviewed': len(reviewed), 'agree': sum(1 for i in reviewed if i['review'] == 'agree')}
    return value
