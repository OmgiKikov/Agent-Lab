"""«Было → стало»: the current result of a check against its previous saved check, criterion by criterion, only when
both have the same criteria and models (history.comparison). Reads saved records; no model is called
(docs/superpowers/specs/2026-10-04-was-is-design.md, section 4)."""

from . import checks, history, problems, store
from .context import sources


def saved_checks(check: str) -> list[dict]:
    """The saved checks of one check, the newest first: their lines."""
    return store.tone_checks() if check == checks.TONE else store.code_checks()


def saved_check(check: str, check_id: str) -> dict | None:
    return store.tone_check(check_id) if check == checks.TONE else store.code_check(check_id)


def line(record: dict | None) -> dict | None:
    """A saved check in a line: which it is, when, of which export, and its counts."""
    if record is None:
        return None
    return {key: record.get(key) for key in ('id', 'finishedAt', 'file', 'summary')}


def criteria(analysis: dict) -> dict[str, dict]:
    """Each criterion of a result by its key (problems.rule_key, as on the screen of problems): its wording and the
    errors among the conversations where it could be checked."""
    book = problems.Book(sources.load())
    problems.from_logs(book, analysis)
    found = {}
    for entry in book.rules.values():
        side, _ = problems.verdicts(entry, 'log')
        found[entry['id']] = {
            'name': entry['rule']['name'] or entry['rule']['text'],
            'text': entry['rule']['text'],
            'counts': {'failed': side['failed'], 'measured': side['failed'] + side['passed']},
        }
    return found


def rows(before: dict[str, dict], now: dict[str, dict]) -> list[dict]:
    """The criteria of both checks side by side: those with errors now first, then those with errors only before, then
    the rest; a criterion one check did not have is null on its side."""
    found = []
    for key in {**before, **now}:
        then, current = before.get(key), now.get(key)
        row = {
            'id': key,
            'name': (current or then)['name'],
            'text': (current or then)['text'],
            'before': then['counts'] if then else None,
            'now': current['counts'] if current else None,
        }
        row['verdict'], row['direction'] = history.verdict(row['before'], row['now'])
        found.append(row)

    def order(row: dict) -> tuple:
        failed_now, failed_before = (row['now'] or {}).get('failed', 0), (row['before'] or {}).get('failed', 0)
        return (0 if failed_now else 1 if failed_before else 2, -failed_now, -failed_before, row['name'])

    return sorted(found, key=order)


def build(check: str) -> dict:
    """The current result against the saved check before it. Without a current result (a new export not checked yet)
    the last saved check is named, nothing compared; a result from before the history has nothing to compare with."""
    saved = saved_checks(check)
    result = store.load(checks.result(check)) or {}
    current = next((record for record in saved if record['id'] == result.get('checkId')), None)
    if current is None:
        latest = None if result.get('results') else next(iter(saved), None)
        return {
            'check': check,
            'kind': 'none' if latest else 'first',
            'reason': 'Текущего итога ещё нет.' if latest else 'Сравнивать не с чем.',
            'current': None,
            'previous': line(latest),
        }
    comparison = current['comparison']
    previous = next((record for record in saved if record['id'] == comparison.get('previousId')), None)
    answer = {
        'check': check,
        'kind': comparison['kind'],
        'reason': comparison['reason'],
        'current': line(current),
        'previous': line(previous),
    }
    if previous is None or comparison['kind'] not in ('new-data', 'same-data'):
        return answer
    before, now = (
        {'failed': record['summary']['failed'], 'measured': record['summary']['measured']}
        for record in (previous, current)
    )
    verdict, direction = history.verdict(before, now)
    answer['overall'] = {'before': before, 'now': now, 'verdict': verdict, 'direction': direction}
    earlier = saved_check(check, previous['id'])['result']
    answer['criteria'] = rows(criteria(earlier), criteria(result))
    serious = set(store.severity()[check])
    if serious:
        # The conversations with a serious error on both sides, by the marks as they are now.
        found = [problems.serious_counts(analysis, serious) for analysis in (earlier, result)]
        then, current = (
            {'failed': counts['failed'], 'measured': side['measured']}
            for counts, side in zip(found, (before, now), strict=True)
        )
        verdict, direction = history.verdict(then, current)
        # The share rests on the conversations where a serious criterion could be checked: where it seldom applied,
        # on either side, nothing more is said than for a criterion checked in so few conversations (history.FEW).
        if verdict and min(counts['checked'] for counts in found) < history.FEW:
            verdict = 'few'
        answer['serious'] = {
            'before': then,
            'now': current,
            'checked': {'before': found[0]['checked'], 'now': found[1]['checked']},
            'verdict': verdict,
            'direction': direction,
        }
    return answer
