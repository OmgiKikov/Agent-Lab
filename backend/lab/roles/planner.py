"""The planner and the router of the accuracy check (Точность).

The planner reads the agent's prompts and tools and the customers' requests, and writes the business topics of the
requests with the criteria each topic is checked by, every criterion grounded in an exact quote of a source; it places
every request in one topic. The router sorts new requests into topics found before. A request is named by a short id
(d1, d2…) and given only by the customer's words.
"""

from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from .base import Answer, NonBlank, Role, ask, instructions

# One answer of the planner places 100–300 conversations: one it leaves out is in no topic and counts as «не удалось
# проверить», one it repeats stays in its first topic. An answer that places fewer is asked again.
PLACED = 0.9


class Criterion(BaseModel):
    """An expectation grounded in a source: what the agent must do, when, how else it may, and the source's words."""

    model_config = ConfigDict(strict=True, extra='allow', populate_by_name=True)

    observation: Literal['reply', 'tool', 'state']
    text: NonBlank
    source_id: NonBlank = Field(alias='sourceId')
    quote: NonBlank
    condition: str
    acceptable: str


class Topic(BaseModel):
    model_config = ConfigDict(strict=True, extra='allow', populate_by_name=True)

    title: NonBlank
    rules: list[Criterion]
    dialogue_ids: list[str] = Field(alias='dialogueIds')


class Plan(BaseModel):
    model_config = ConfigDict(strict=True)

    topics: list[Topic] = Field(min_length=1)


class Assignment(BaseModel):
    model_config = ConfigDict(strict=True, populate_by_name=True)

    dialogue_id: str = Field(alias='dialogueId')
    topic_id: str = Field(alias='topicId')


class Placement(BaseModel):
    model_config = ConfigDict(strict=True)

    # An item that is no assignment places nothing; it does not cost the rest of the answer.
    assignments: list[Annotated[Assignment | Any, Field(union_mode='left_to_right')]]


PLANNER = Role('planner', instructions('planner'), Plan)
ROUTER = Role('router', instructions('router'), Placement)


def requests(dialogues: list[dict]) -> list[dict]:
    """What the planner and the router see of the conversations: short ids (d1..dN) and the customer's words."""
    return [
        {'id': f'd{i}', 'customer': '\n'.join(m['content'] for m in d['messages'] if m['role'] == 'user')[:600]}
        for i, d in enumerate(dialogues, 1)
    ]


def short_ids(dialogues: list[dict]) -> dict[str, str]:
    """The conversation each short id of the requests stands for."""
    return {f'd{i}': str(d['id']) for i, d in enumerate(dialogues, 1)}


def _placed_enough(placed: set[str], expected: set[str], message: str) -> None:
    if len(placed & expected) < PLACED * len(expected):
        raise ValueError(message)


async def plan(task: str, sources: list[dict], requests: list[dict]) -> Answer[list[dict]]:
    """The topics as the planner wrote them, criteria and requests by their short ids included; the planner is asked
    again when it places fewer than PLACED of the requests."""
    expected = {request['id'] for request in requests}

    def placed_all(reply: Plan) -> list[dict]:
        placed = {request for topic in reply.topics for request in topic.dialogue_ids}
        _placed_enough(placed, expected, 'assign every conversation exactly once')
        return [topic.model_dump(by_alias=True, exclude_unset=True) for topic in reply.topics]

    return await ask(PLANNER, {'task': task, 'sources': sources, 'dialogues': requests}, accept=placed_all)


async def place(topics: list[dict], requests: list[dict]) -> Answer[list[tuple[str, str]]]:
    """(request, topic) for each new request the router placed in a known topic, in the order it wrote them; asked
    again when it places fewer than PLACED of them."""
    known_requests, known_topics = {request['id'] for request in requests}, {topic['id'] for topic in topics}

    def placed_new(reply: Placement) -> list[tuple[str, str]]:
        placed = [
            (item.dialogue_id, item.topic_id)
            for item in reply.assignments
            if isinstance(item, Assignment) and item.dialogue_id in known_requests and item.topic_id in known_topics
        ]
        _placed_enough({request for request, _ in placed}, known_requests, 'assign every new conversation to a topic')
        return placed

    payload = {'topics': [{'id': topic['id'], 'title': topic['title']} for topic in topics], 'dialogues': requests}
    return await ask(ROUTER, payload, accept=placed_new)
