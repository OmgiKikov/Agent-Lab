"""What the current agent keeps that measures the Lab's own instruments (python -m lab.eval): every verdict a person
answered (storage.reviews) and the journal of calls to the models (storage.calls). Reads only."""

from .. import storage
from ..domain import answers, checks
from ..roles import judge

# The role of the judge whose verdicts the answers of each source are on.
ROLES = {answers.LOG: judge.JUDGE_LOG.name, answers.SIM: judge.JUDGE_RUN.name}


def answered() -> list[dict]:
    """Every verdict a person answered, with their answer: {role, version, check, status, decision}. A verdict is the
    one the answer was given on: its case, the version of the judge's instructions, the status and the agent's words
    it quoted. A person's latest word on a verdict counts, also when a later judgement of the run changed the verdict
    and the Lab took the answer back: it is still that person's word on what that version said. An answer the person
    took back is no answer. An answer the Lab carried to a later check is that person's word on another verdict,
    counted where it was given, and an answer on a played conversation as a whole (older screens) is on no verdict."""
    latest: dict[tuple, dict] = {}
    for row in storage.reviews.journal():
        if row['author'] != storage.reviews.PERSON or row['ruleId'] == answers.WHOLE:
            continue
        # An error is the words it points at; a verdict «без ошибки» is about the conversation (quotes.same_finding).
        verdict = (row['version'], row['status'], row['quote'] if row['status'] == 'FAIL' else None)
        latest[(row['source'], row['recordId'], row['conversation'], row['ruleId'], verdict)] = row
    kinds = {line['id']: kind for kind in checks.RESULTS for line in storage.history.lines(kind)}
    runs = {summary['id']: summary.get('check') for summary in storage.runs.summaries()}
    found = []
    for (source, record, *_), row in latest.items():
        if row['decision'] not in answers.DECISIONS:
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
