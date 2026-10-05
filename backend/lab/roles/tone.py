"""Criteria of tone of voice from a person's rules of communication, when the rules do not define them in code
(flows: tone.coded_criteria). Every criterion quotes the rules exactly; no two quote the same words."""

from pydantic import BaseModel, ConfigDict, Field

from ..domain import quotes
from .base import Answer, NonBlank, Role, ask, instructions


class Criterion(BaseModel):
    model_config = ConfigDict(strict=True, extra='allow')

    name: NonBlank
    text: NonBlank
    quote: str
    condition: str
    acceptable: str


class Criteria(BaseModel):
    model_config = ConfigDict(strict=True)

    criteria: list[Criterion] = Field(min_length=1, max_length=20)


CRITERIA = Role('tone.criteria', instructions('tone.criteria'), Criteria)


async def criteria(policy: dict) -> Answer[list[dict]]:
    """The criteria of the rules (policy: their source), numbered t1r1, t1r2…, each observed in the agent's replies."""

    def grounded(reply: Criteria) -> list[dict]:
        found = []
        for index, row in enumerate(reply.criteria, 1):
            if not quotes.found(row.quote, policy['content']):
                raise ValueError('criterion must be grounded in the supplied policy')
            found.append(
                row.model_dump(exclude_unset=True)
                | {'id': f't1r{index}', 'sourceId': policy['id'], 'observation': 'reply'}
            )
        if len({quotes.normalized(row['quote']) for row in found}) != len(found):
            raise ValueError('criteria must not repeat the same source quote')
        return found

    return await ask(CRITERIA, {'policy': policy['content']}, accept=grounded)
