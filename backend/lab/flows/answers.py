"""A person's answer on a verdict: on a criterion of a logged conversation in a check's result, or of a played
conversation in a run (domain.answers). It lands only on the result (finishedAt), the verdict (status) and the answer
(before) the person saw, when the request names them: an answer given meanwhile in another tab or browser is never
overwritten unseen. Answers are rows of their own (storage.reviews): giving one rewrites neither the result nor the
run."""

from typing import Any

from .. import storage
from ..domain import answers, checks

# A person's answer on a verdict that is no longer the one they saw.
CHANGED = 'Ответ не сохранён: оценка изменилась. Обновите страницу.'
ANSWERED = 'Ответ не сохранён: на этот случай уже ответили, пока вы смотрели. Проверьте ответ на экране.'
NOT_CHECKED = 'Этот критерий в разговоре не проверялся.'  # an answer on a logged conversation without this verdict
# The answer a person saw on a case, when a request does not name one (an older screen): then it is not compared.
UNSEEN: Any = object()


def check_of(check: str | None, finished_at: str | None, dialogue_id: str, rule_id: str) -> str:
    """The check whose result an answer on a logged conversation goes to: the one it names, else the one whose result
    the person saw (finished_at), else the first whose result has this verdict. ValueError: the result the person saw
    is no longer there (CHANGED); LookupError: no result has this verdict."""
    if check:
        return check
    found = {key: storage.documents.load(checks.result(key)) or {} for key in checks.RESULTS}
    if finished_at:
        seen = next((key for key, value in found.items() if value.get('finishedAt') == finished_at), None)
        if seen is None:
            raise ValueError(CHANGED)
        return seen
    judged = next((key for key, value in found.items() if _verdict(value, dialogue_id, rule_id)), None)
    if judged is None:
        raise LookupError(NOT_CHECKED)
    return judged


def on_log(
    check: str,
    dialogue_id: str,
    rule_id: str,
    decision: str | None,
    finished_at: str | None = None,
    status: str | None = None,
    before: Any = UNSEEN,
) -> None:
    """A person's decision on one criterion's verdict in a logged conversation of the check's current result, kept under
    its saved check, which outlives the result (a new export). KeyError: the result has no such verdict."""
    with storage.transaction():
        result = storage.documents.load(checks.result(check)) or {}
        if finished_at and result.get('finishedAt') != finished_at:
            raise ValueError(CHANGED)
        judged = _verdict(result, dialogue_id, rule_id)
        if judged is None:
            raise KeyError(rule_id)
        item, row = judged
        if status and row.get('status') != status:
            raise ValueError(CHANGED)
        record_id = answers.record_of(check, result)
        if before is not UNSEEN:
            seen = storage.reviews.visible(answers.LOG, record_id).get((dialogue_id, rule_id)) or {}
            if seen.get('decision') != before:
                raise ValueError(ANSWERED)
        given = answers.found(dialogue_id, rule_id, decision, row, item.get('judgeVersion'))
        storage.reviews.give(answers.LOG, record_id, [given])


def on_run(
    run_id: str,
    index: int,
    decision: str | None,
    rule_id: str | None = None,
    status: str | None = None,
    before: Any = UNSEEN,
) -> dict:
    """A person's decision on a played conversation: on one criterion's verdict, or (older screens) on the whole
    conversation. The run with it, its metric counting it. KeyError: no such run or criterion; IndexError: no such
    conversation."""
    if isinstance(index, bool) or not isinstance(index, int) or index < 0:
        raise IndexError(index)
    with storage.transaction():
        record = storage.runs.get(run_id)
        if record is None:
            raise KeyError(run_id)
        item = record['items'][index]
        conversation, version = str(index), item.get('judgeVersion')
        if not rule_id:
            given = answers.found(conversation, answers.WHOLE, decision, item, version)
        else:
            row = next((row for row in item.get('rules') or [] if row.get('ruleId') == rule_id), None)
            if row is None:
                raise KeyError(rule_id)
            if status and row.get('status') != status:
                raise ValueError(CHANGED)
            if before is not UNSEEN and row.get('review') != before:
                raise ValueError(ANSWERED)
            given = answers.found(conversation, rule_id, decision, row, version)
        storage.reviews.give(answers.SIM, run_id, [given])
        return storage.runs.get(run_id)


def _verdict(analysis: dict, dialogue_id: str, rule_id: str) -> tuple[dict, dict] | None:
    """The conversation of a result and its verdict on one criterion, when the result has them."""
    for item in analysis.get('results') or []:
        if str(item.get('dialogueId')) != dialogue_id:
            continue
        row = next((row for row in item.get('rules') or [] if row.get('ruleId') == rule_id), None)
        if row is not None:
            return item, row
    return None
