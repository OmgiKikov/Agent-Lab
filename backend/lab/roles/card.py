"""The card of a scenario's customer from one logged conversation (domain/cards.py): the model reads the whole chat,
the customer's and the agent's messages, and cites every item; the code keeps only what it finds in the log."""

from typing import Any

from ..domain import cards
from .base import Answer, Role, ask, instructions

# The answer is read item by item (cards.grounded): one doubtful item is dropped, never the whole card.
CARD = Role('card', instructions('card'), dict[str, Any])


async def card(topic: str, dialogue: dict, start: int | None = None) -> Answer[dict]:
    """The extractor's card of the conversation's customer, or one that says the conversation has no acquiring task
    (eligible: false, ineligibleReason). start: the customer's event where the acquiring episode starts, when the
    catalog has read it."""
    payload = {'topic': topic, 'chat': cards.chat(dialogue), 'events': cards.events(dialogue)}
    if start is not None:
        payload['episodeStart'] = start
    return await ask(CARD, payload, accept=cards.readable)
