"""Serious and minor errors. After a check, when the screens ask
for it, the model proposes for each criterion of the check's result whether an error by it is serious, with a reason a
person can weigh; a person confirms or changes it. A person's decision always wins: the model is never asked about a
criterion a person decided, and its proposals live apart from the decisions (storage.severity)."""

import asyncio

from .. import models, storage
from ..domain import checks, problems
from ..roles import severity as role
from . import Progress

# Criteria asked about in one call: the reply stays short enough to answer for each.
CHUNK = 30
# What the task says while the model proposes, with the check it proposes for (the screens lead to its criteria).
PROPOSING = 'Отмечаем серьёзные ошибки'


def criteria(check: str) -> dict[str, dict]:
    """The criteria of the check's current result by their key (problems.rule_key), as the screens group them."""
    return _criteria(storage.documents.load(checks.result(check)) or {})


def _criteria(analysis: dict) -> dict[str, dict]:
    found: dict[str, dict] = {}
    for topic in analysis.get('topics') or []:
        for rule in topic['rules']:
            found.setdefault(problems.rule_key(rule.get('quote') or rule['text']), rule)
    return found


async def propose(check: str, progress: Progress | None = None, again: bool = False) -> str | None:
    """Ask the model about the criteria of the check's result it has no proposal for (every one `again`), never about
    one a person decided. Each answered part is saved at once; a failure is saved as the reason and returned, never
    raised: the check it follows stands."""
    analysis = storage.documents.load(checks.result(check)) or {}
    found = _criteria(analysis)
    marks = storage.severity.marks()[check]
    proposals = storage.severity.proposed()[check]['proposals']
    todo = [key for key in found if key not in marks and (again or key not in proposals)]
    if not todo:
        return None
    if progress:
        progress(message=PROPOSING, check=check)
    # The proposals are about the check's result: the journal counts them with the check they follow.
    with models.about(f'check:{analysis["checkId"]}' if analysis.get('checkId') else f'severity:{check}'):
        for start in range(0, len(todo), CHUNK):
            part = todo[start : start + CHUNK]
            ids = {f'c{number}': key for number, key in enumerate(part, 1)}
            try:
                answer = await role.propose(check, [role.shown(found[key], id_) for id_, key in ids.items()])
            except models.ModelError as error:
                storage.severity.failed(check, str(error))
                return str(error)
            storage.severity.propose(check, {key: answer.value[id_] for id_, key in ids.items()}, answer.model)
    return None


async def proposed_after(check: str, progress: Progress) -> None:
    """The serious errors the model proposes after a check it follows, which is published by then. «Остановить» here
    stops only the proposals: the task ends as done, with the check saved, never «Остановлено» beside a result that
    stands. Each answered part is saved at once (propose); «Отметить автоматически» asks for the rest."""
    try:
        await propose(check, progress)
    except asyncio.CancelledError:
        # The Lab closing is no person's stop: the task stays running, and the next process proposes the rest.
        if storage.tasks.closing():
            raise
        current = asyncio.current_task()
        if current is not None:
            current.uncancel()


async def propose_again(check: str, progress: Progress, *, again: bool = False) -> dict:
    """«Предложить»: the model proposes which errors of the check's criteria are serious — for a result checked before
    proposals, after a failed proposal, or `again` for every criterion a person has not decided. A failure is the
    task's error."""
    progress(message=PROPOSING, check=check)
    error = await propose(check, progress, again=again)
    if error:
        raise models.ModelError(error)
    return {'severity': storage.severity.serious()}


def confirm(check: str) -> dict:
    """«Подтвердить все»: a person takes the model's proposals for the criteria of the check's result as their own."""
    return {'severity': storage.severity.confirm(check, list(criteria(check)))}
