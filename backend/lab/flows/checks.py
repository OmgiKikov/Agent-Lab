"""What the screens read of the two checks of the real conversations: the rules and problems of a check, «было →
стало», the saved checks with the answers given on them, one conversation with its evaluation; and a person's answer
on a verdict. Reads stored records only: no model is called.
"""

from .. import agents, store
from ..domain import checks, metric, results, statistics, was_is
from ..domain import problems as problem_book
from . import inputs

NOT_CHECKED = 'Этот критерий в разговоре не проверялся.'  # an answer on a logged conversation without this verdict


def chosen_run(check: str, run_id: str | None) -> dict | None:
    """The run asked for; else, as «Обзор» shows it, the newest finished run of this check with a conversation checked:
    a newer run the model could check nothing of is no latest result. Without one, the newest finished run of this
    check that has conversations."""
    if run_id:
        return store.run(run_id)
    finished = [
        r
        for r in store.runs()
        if r.get('finishedAt') and r.get('status') != 'running' and r.get('items') and checks.of_run(r) == check
    ]
    checked = (r for r in finished if (r.get('metric') or metric.metric(r['items']))['measured'])
    return next(checked, finished[0] if finished else None)


def problems(check: str, run_id: str | None = None) -> dict:
    """The check's rules and problems: its result on one side, the run asked for (else its newest finished run) on
    the other. Its scenarios are named only when the deck was built from this check. The serious criteria come first
    (a person's decision, else the model's proposal), then by frequency; `severity` counts, among the criteria of the
    check's result, the ones the model proposed for and a person did not decide yet, the ones a person decided, and says
    why the last proposal failed while one of them has neither."""
    document = store.load(checks.DECK) or {}
    deck = document.get('cards') or []
    serious = set(store.severity()[check])
    marks = store.severity_marks()[check]
    proposed = store.severity_proposed()[check]
    book = problem_book.Book(inputs.sources())
    log = problem_book.from_logs(book, store.load(checks.result(check)) or {}, serious)
    run = chosen_run(check, run_id)
    sim = problem_book.from_run(book, run, deck, agents.run_name(run) if run else '')
    built = deck if document.get('check') == check else []
    rules = [problem_book.finish(entry, built, serious, marks, proposed['proposals']) for entry in book.rules.values()]
    rules.sort(key=lambda r: (not r['serious'], -r['log']['failed'], -r['sim']['failed'], r['rule']['text']))
    # The criteria of the result: the model proposes for these and «Подтвердить все» confirms them; one only a run has
    # is listed, but nobody proposes for it.
    by = [rule['severity']['by'] for rule in rules if rule['log']['ruleIds']]
    return {
        'check': check,
        'log': log,
        'sim': sim,
        'rules': rules,
        'problems': [r['id'] for r in rules if r['log']['failed'] or r['sim']['failed']],
        'severity': {
            'criteria': len(by),
            'proposed': by.count('model'),
            'decided': by.count('person'),
            'error': proposed['error'] if None in by else None,
        },
    }


def saved_checks(check: str) -> list[dict]:
    """The saved checks of one check, the newest first: their lines. A line compared with the one before it says, as
    «было → стало» on the result does, what a person may read into the difference (statistics.verdict); «не удалось
    проверить» counts its whole sample (results.with_unmeasured)."""
    lines = store.tone_checks() if check == checks.TONE else store.code_checks()
    for line in lines:
        line['summary'] = results.with_unmeasured(line['summary'], line.get('sampled'))
    by_id = {line['id']: line for line in lines}
    for line in lines:
        comparison = line.get('comparison') or {}
        previous = by_id.get(comparison.get('previousId'))
        if previous is None or comparison.get('kind') not in ('new-data', 'same-data'):
            continue
        before, now = (
            {'failed': record['summary']['failed'], 'measured': record['summary']['measured']}
            for record in (previous, line)
        )
        verdict, direction = statistics.verdict(before, now)
        line['comparison'] = {**comparison, 'verdict': verdict, 'direction': direction}
    return lines


def saved_check(check: str, check_id: str) -> dict | None:
    return store.tone_check(check_id) if check == checks.TONE else store.code_check(check_id)


def with_reviews(check: str, check_id: str) -> dict | None:
    """A saved check with its evidence and the answers people gave on it since it finished, over the ones it was saved
    with; None when there is no such check."""
    snapshot = saved_check(check, check_id)
    if snapshot is None:
        return None
    reviews = store.tone_reviews(check_id) if check == checks.TONE else store.code_reviews(check_id)
    for record in (snapshot['check'], snapshot['result']):
        if isinstance(record.get('summary'), dict):
            record['summary'] = results.with_unmeasured(record['summary'], record.get('sampled'))
    decisions = {(row['dialogueId'], row['ruleId']): row['decision'] for row in reviews}
    for result in snapshot['result']['results']:
        for row in result.get('rules', []):
            key = (str(result['dialogueId']), row['ruleId'])
            if key in decisions:
                row['review'] = decisions[key]
    snapshot.update(reviews=reviews, reviewSemantics='latest-saved')
    return snapshot


def comparison(check: str) -> dict:
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
            'previous': was_is.line(latest),
        }
    comparison = current['comparison']
    previous = next((record for record in saved if record['id'] == comparison.get('previousId')), None)
    answer = {
        'check': check,
        'kind': comparison['kind'],
        'reason': comparison['reason'],
        'current': was_is.line(current),
        'previous': was_is.line(previous),
    }
    if previous is None or comparison['kind'] not in ('new-data', 'same-data'):
        return answer
    before, now = (
        {'failed': record['summary']['failed'], 'measured': record['summary']['measured']}
        for record in (previous, current)
    )
    verdict, direction = statistics.verdict(before, now)
    answer['overall'] = {'before': before, 'now': now, 'verdict': verdict, 'direction': direction}
    earlier = saved_check(check, previous['id'])['result']
    quoted = inputs.sources()
    answer['criteria'] = was_is.rows(was_is.criteria(earlier, quoted), was_is.criteria(result, quoted))
    serious = set(store.severity()[check])
    if serious:
        # The conversations with a serious error on both sides, by the marks as they are now.
        found = [problem_book.serious_counts(analysis, serious) for analysis in (earlier, result)]
        then, current = (
            {'failed': counts['failed'], 'measured': side['measured']}
            for counts, side in zip(found, (before, now), strict=True)
        )
        verdict, direction = statistics.verdict(then, current)
        # The share rests on the conversations where a serious criterion could be checked: where it seldom applied,
        # on either side, nothing more is said than for a criterion checked in so few conversations (statistics.FEW).
        if verdict and min(counts['checked'] for counts in found) < statistics.FEW:
            verdict = 'few'
        answer['serious'] = {
            'before': then,
            'now': current,
            'checked': {'before': found[0]['checked'], 'now': found[1]['checked']},
            'verdict': verdict,
            'direction': direction,
        }
    return answer


def line(check: str) -> dict | None:
    """The current result of one check in one line: errors of measured, not checked, when."""
    value = store.load(checks.result(check)) or {}
    summary = results.with_unmeasured(value.get('summary') or {}, value.get('sampled'))
    if not value.get('finishedAt') or any(key not in summary for key in ('failed', 'measured', 'unmeasured')):
        return None  # nothing finished, or a record of another shape: never a reason to hide the other agents
    return {key: summary[key] for key in ('failed', 'measured', 'unmeasured')} | {'finishedAt': value['finishedAt']}


def conversation(dialogue_id: str, check: str | None = None) -> dict | None:
    """A logged conversation with its evaluation in the result of the check asked for; without one, in tone of voice's
    result, then in Точность's. None when the export has no such conversation."""
    dialogue = store.dialogue(dialogue_id)
    if dialogue is None:
        return None
    evaluation = None
    for key in [check] if check else checks.RESULTS:
        analysis = store.load(checks.result(key)) or {}
        evaluation = next(
            (result for result in analysis.get('results', []) if str(result['dialogueId']) == dialogue_id), None
        )
        if evaluation:
            break
    return {**dialogue, 'evaluation': evaluation}


def answered_check(check: str | None, finished_at: str | None, dialogue_id: str, rule_id: str) -> str:
    """The check whose result an answer on a logged conversation goes to: the one it names, else the one whose result
    the person saw (finished_at), else the first whose result has this verdict. ValueError: the result the person saw
    is no longer there (store.CHANGED); LookupError: no result has this verdict."""
    if check:
        return check
    found = {key: store.load(checks.result(key)) or {} for key in checks.RESULTS}
    if finished_at:
        seen = next((key for key, value in found.items() if value.get('finishedAt') == finished_at), None)
        if seen is None:
            raise ValueError(store.CHANGED)
        return seen
    judged = next((key for key, value in found.items() if _has_verdict(value, dialogue_id, rule_id)), None)
    if judged is None:
        raise LookupError(NOT_CHECKED)
    return judged


def _has_verdict(analysis: dict, dialogue_id: str, rule_id: str) -> bool:
    return any(
        str(result.get('dialogueId')) == dialogue_id and any(row.get('ruleId') == rule_id for row in result['rules'])
        for result in analysis.get('results') or []
        if result.get('rules')
    )
