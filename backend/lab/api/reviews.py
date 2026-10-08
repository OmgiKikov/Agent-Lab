"""A person's answer on a verdict: «верно» or «неверно» on what the judge found in a logged or a played conversation,
or the answer taken back (flows.answers)."""

from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from ..domain import checks
from ..flows import answers
from .base import Jobs

router = APIRouter()

# The job that writes a check's result: while it runs, answers on that result would be lost.
WRITES = {'tone-check': checks.TONE, 'discover': checks.CODE}


def writes(job: dict) -> str | None:
    """The check whose result the running job writes: a check of its own, or a launch that checks the recorded
    answers (its mode «Ответы в датасете»)."""
    if job.get('kind') == 'launch':
        given = job.get('input') or {}
        return given.get('check') if 'dataset' in (given.get('modes') or ()) else None
    return WRITES.get(job.get('kind'))


class ReviewCommand(BaseModel):
    """A person's decision on what the judge found: on one criterion of a logged or simulated conversation, or (older
    requests without ruleId) on a simulated conversation as a whole. On a logged one, check names the check whose
    result it goes to. finishedAt (the check's result), status (the verdict) and before (the answer on it, null for
    none) are what the person saw: when any changed meanwhile, the decision is refused. Without before (older
    screens) the answer on the case is not compared."""

    source: Literal['log', 'sim'] = 'sim'
    check: Literal['tone', 'code'] | None = None
    run: str = ''
    index: int | None = Field(default=None, ge=0, strict=True)
    dialogueId: str = ''
    ruleId: str = ''
    decision: Literal['agree', 'disagree'] | None = None
    finishedAt: str | None = None
    status: str | None = None
    before: Literal['agree', 'disagree'] | None = None

    def seen(self) -> object:
        """The answer the person saw on the case, or answers.UNSEEN when the request does not say."""
        return self.before if 'before' in self.model_fields_set else answers.UNSEEN


@router.post('/api/review')
async def review(jobs: Jobs, payload: ReviewCommand) -> dict:
    if payload.source == 'log':
        return _on_log(jobs, payload)
    if payload.index is None:
        raise HTTPException(422, 'Нужны run и index')
    try:
        record = answers.on_run(
            payload.run, payload.index, payload.decision, payload.ruleId or None, payload.status, payload.seen()
        )
    except (KeyError, IndexError) as error:
        raise HTTPException(404, 'Разговор не найден') from error
    except ValueError as error:
        raise HTTPException(409, str(error)) from error
    return {'ok': True, 'metric': record['metric']}


def _on_log(jobs: Jobs, payload: ReviewCommand) -> dict:
    """An answer on a logged conversation, in the result of the check it goes to; refused while that check runs."""
    if not payload.dialogueId or not payload.ruleId:
        raise HTTPException(422, 'Нужны dialogueId и ruleId')
    try:
        check = answers.check_of(payload.check, payload.finishedAt, payload.dialogueId, payload.ruleId)
    except ValueError as error:
        raise HTTPException(409, str(error)) from error
    except LookupError as error:
        raise HTTPException(404, str(error)) from error
    if jobs.state['running'] and writes(jobs.state) == check:
        raise HTTPException(
            409, f'Ответ не сохранится, пока идёт проверка «{checks.NAMES[check]}». Ответьте после неё.'
        )
    try:
        answers.on_log(
            check,
            payload.dialogueId,
            payload.ruleId,
            payload.decision,
            payload.finishedAt,
            payload.status,
            payload.seen(),
        )
    except KeyError as error:
        raise HTTPException(404, answers.NOT_CHECKED) from error
    except ValueError as error:
        raise HTTPException(409, str(error)) from error
    return {'ok': True}
