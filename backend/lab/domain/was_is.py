"""«Было → стало»: the current result of a check beside its previous saved check, criterion by criterion, when both
have the same criteria and models (comparison.comparison); what a person may read into each difference is
statistics.verdict's. Pure functions."""

from . import problems, statistics


def line(record: dict | None) -> dict | None:
    """A saved check in a line: which it is, when, of which export, and its counts."""
    if record is None:
        return None
    return {key: record.get(key) for key in ('id', 'finishedAt', 'file', 'summary')}


def criteria(analysis: dict, sources: list[dict]) -> dict[str, dict]:
    """Each criterion of a result by its key (problems.rule_key, as on the screen of problems): its wording and the
    errors among the checked conversations where it was decided, the same ones the screen of problems counts.
    sources: what the criteria quote."""
    book = problems.Book(sources)
    problems.from_logs(book, analysis)
    found = {}
    for entry in book.rules.values():
        side, _ = problems.verdicts(book, entry, 'log')
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
        row['verdict'], row['direction'] = statistics.verdict(row['before'], row['now'])
        found.append(row)

    def order(row: dict) -> tuple:
        failed_now, failed_before = (row['now'] or {}).get('failed', 0), (row['before'] or {}).get('failed', 0)
        return (0 if failed_now else 1 if failed_before else 2, -failed_now, -failed_before, row['name'])

    return sorted(found, key=order)
