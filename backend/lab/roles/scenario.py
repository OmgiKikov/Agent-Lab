"""A scenario from one logged conversation: the situation a synthetic customer plays, taken from the customer's own
messages, without the behaviour expected of the agent or the criteria it is judged by."""

from pydantic import BaseModel, ConfigDict

from .base import Answer, NonBlank, Role, ask, instructions


class Scenario(BaseModel):
    model_config = ConfigDict(strict=True)

    name: NonBlank
    situation: NonBlank


SCENARIO = Role('scenario', instructions('scenario'), Scenario)


async def scenario(topic: str, customer: list[str]) -> Answer[Scenario]:
    """The scenario of a conversation of this topic, from what the customer wrote in it."""
    return await ask(SCENARIO, {'topic': topic, 'customerMessages': customer})
