"""What the current agent keeps that measures the Lab's own instruments (python -m lab.eval): every verdict a person
answered (storage.reviews) and the journal of calls to the models (storage.calls). Reads only."""

from .. import storage
from ..domain import answers, checks
from ..roles import judge

# The role of the judge whose verdicts the answers of each source are on.
ROLES = {answers.LOG: judge.JUDGE_LOG.name, answers.SIM: judge.JUDGE_RUN.name}


def answered() -> list[dict]:
    """Every verdict a person answered, with the answer: {role, version, check, status, decision}. The visible answer
    on a case counts when a person gave it: one the Lab carried to a later check is that person's answer on another
    verdict, counted where it was given, and one taken back is no answer. An answer on a played conversation as a
    whole (older screens) is on no verdict of the judge."""
    latest: dict[tuple, dict] = {}
    for row in storage.reviews.journal():
        latest[(row['source'], row['recordId'], row['conversation'], row['ruleId'])] = row
    kinds = {line['id']: kind for kind in checks.RESULTS for line in storage.history.lines(kind)}
    runs = {summary['id']: summary.get('check') for summary in storage.runs.summaries()}
    found = []
    for (source, record, _, rule_id), row in latest.items():
        if row['author'] != storage.reviews.PERSON or row['decision'] not in answers.DECISIONS:
            continue
        if rule_id == answers.WHOLE:
            continue
        if source == answers.LOG:
            # A result from before the history of checks keeps its answers under its check and time (record_of).
            check = kinds.get(record) or (record.partition('@')[0] if '@' in record else None)
        else:
            check = runs.get(record)
        found.append(
            {
                'role': ROLES[source],
                'version': row['version'],
                'check': check,
                'status': row['status'],
                'decision': row['decision'],
            }
        )
    return found


def calls() -> list[dict]:
    """The journal of calls to the models, the oldest first."""
    return storage.calls.listed()
