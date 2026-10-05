"""Serious and minor errors: a person's decision on a criterion,
the model's proposals and taking them all."""

from typing import Literal

from fastapi import APIRouter
from pydantic import BaseModel, Field

from .. import storage
from ..flows import severity
from .base import Jobs, start

router = APIRouter()


class SeverityCommand(BaseModel):
    """A person decides whether the errors of a criterion of a check are serious; the criterion by its key."""

    check: Literal['tone', 'code']
    rule: str = Field(pattern=r'^r-[0-9a-f]{10}$')
    serious: bool


class SeverityProposeCommand(BaseModel):
    """The model proposes for the criteria of a check's result it has no proposal for (every one `again`)."""

    check: Literal['tone', 'code']
    again: bool = False


class SeverityConfirmCommand(BaseModel):
    """A person takes every proposal of the model for a check's criteria as their own decision."""

    check: Literal['tone', 'code']


@router.post('/api/severity')
def mark_severity(payload: SeverityCommand) -> dict:
    """A person decides whether a criterion's errors are serious or minor: serious ones come first and are counted
    apart. The decision wins over the model's proposal and changes neither what is checked nor how."""
    return {'severity': storage.severity.decide(payload.check, payload.rule, payload.serious)}


@router.post('/api/severity/propose')
async def propose_severity(jobs: Jobs, payload: SeverityProposeCommand) -> dict:
    """«Предложить»: the model proposes which errors of the check's criteria are serious."""
    return start(
        jobs, 'severity', lambda progress: severity.propose_again(payload.check, progress, again=payload.again)
    )


@router.post('/api/severity/confirm')
def confirm_severity(payload: SeverityConfirmCommand) -> dict:
    """«Подтвердить все»: a person takes the model's proposals for the criteria of the check's result as their own."""
    return severity.confirm(payload.check)
