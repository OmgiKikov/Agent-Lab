"""The world of a scenario (domain/world.py): the client and the data its question depends on, in the shapes of the
stand's fixtures. A world of another shape is an answer nobody can use: the model is asked again."""

from typing import Annotated, Any

from pydantic import BaseModel, BeforeValidator, ConfigDict

from ..domain.world import SCENARIO_TOOLS, normalize
from .base import Answer, Role, ask, instructions


class World(BaseModel):
    model_config = ConfigDict(strict=True, extra='allow')

    organization: dict[str, Any]
    terminals: list[Any]
    # No tools, or nothing in their place, is no data for the scenario.
    tools: Annotated[dict[str, Any] | None, BeforeValidator(lambda value: value or None)] = None


WORLD = Role('world', instructions('world'), World)


async def world(situation: str, customer: list[str], shapes: dict) -> Answer[dict]:
    """The world of a scenario's situation (customer: what the customer wrote), in the stand's shapes."""
    payload = {
        'situation': situation,
        'customerMessages': customer,
        'templates': {name: shapes[name] for name in SCENARIO_TOOLS if name in shapes},
    }
    return await ask(WORLD, payload, accept=lambda reply: normalize(reply.model_dump(), shapes))
