"""Serious and minor errors: for each criterion of a check, whether one error by it is serious, with a reason a person
can weigh. A proposal; a person's decision always wins."""

from typing import Annotated

from pydantic import BaseModel, ConfigDict, StringConstraints

from ..domain.checks import CODE, TONE
from .base import Answer, Role, ask, instructions

# What the model is told the check is about.
ABOUT = {
    TONE: "Tone of voice: how the agent talks to customers, by the bank's rules of communication.",
    CODE: 'Accuracy: whether the agent does what its instructions and tools require.',
}


class Proposal(BaseModel):
    model_config = ConfigDict(strict=True)

    id: str
    serious: bool
    reason: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=300)]


class Proposals(BaseModel):
    model_config = ConfigDict(strict=True)

    criteria: list[Proposal]


SEVERITY = Role('severity', instructions('severity'), Proposals)


def shown(rule: dict, criterion_id: str) -> dict:
    """A criterion as the model reads it: what it requires, when, and what is allowed."""
    return {
        'id': criterion_id,
        'name': rule.get('name') or '',
        'requirement': rule['text'],
        'when': rule.get('condition') or '',
        'acceptable': rule.get('acceptable') or '',
    }


async def propose(check: str, criteria: list[dict]) -> Answer[dict[str, dict]]:
    """One proposal for each criterion shown, by its id: serious or not, and why."""
    ids = [criterion['id'] for criterion in criteria]

    def every_one(reply: Proposals) -> dict[str, dict]:
        found: dict[str, dict] = {}
        for row in reply.criteria:
            if row.id not in ids or row.id in found:
                raise ValueError('every criterion asked about, once')
            found[row.id] = {'serious': row.serious, 'reason': row.reason}
        if len(found) != len(ids):
            raise ValueError('every criterion asked about, once')
        return found

    return await ask(SEVERITY, {'check': ABOUT[check], 'criteria': criteria}, accept=every_one)
