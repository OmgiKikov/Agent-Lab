"""The card of a scenario's customer from one logged conversation (domain/cards.py): the model reads the whole chat,
the customer's and the agent's messages, and cites every item; the code keeps only what it finds in the log. It is
told the agent's domain and the identifiers of its customers (agent: domain/profile.for_models)."""

from typing import Any

from ..domain import cards, profile
from .base import Answer, Role, ask, instructions

# The answer is read item by item (cards.grounded): one doubtful item is dropped, never the whole card.
CARD = Role('card', instructions('card'), dict[str, Any])


async def card(
    topic: str, dialogue: dict, agent: dict, start: int | None = None, end: int | None = None
) -> Answer[dict]:
    """The extractor's card of the conversation's customer (agent: the profile of the agent under test). start, end:
    the events where the episode starts and ends, when the catalog has read them."""
    payload = {
        'agent': profile.for_models(agent),
        'topic': topic,
        'chat': cards.chat(dialogue, agent),
        'events': cards.events(dialogue),
    }
    if start is not None:
        payload['episodeStart'] = start
    if end is not None:
        payload['episodeEnd'] = end
    return await ask(CARD, payload, accept=cards.readable)
