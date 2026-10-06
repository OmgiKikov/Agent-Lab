"""The catalog of business scenarios (domain/catalog.py): the episode reader names each conversation's acquiring task,
the catalog role proposes the categories and scenarios from all the tasks, and the router places episodes in a
catalog found before. An episode is named by a short id (e1, e2…)."""

from typing import Annotated, Any

from pydantic import BaseModel, ConfigDict, Field

from ..domain import catalog
from .base import Answer, NonBlank, Role, ask, instructions

# One answer of the router places a batch of episodes; one it leaves out is placed by the next build.
PLACED = 0.9
# Seconds the catalog role may think: it reads every task of the export at once.
PROPOSING = 900


class Episode(BaseModel):
    """Lenient: a model leaves out a field or answers null where nothing applies; catalog.checked_episode decides."""

    model_config = ConfigDict(extra='allow')

    acquiring: bool | None = None
    reason: str | None = None
    start: int | None = None
    end: int | None = None
    task: str | None = None
    object: str | None = None


class Scenario(BaseModel):
    model_config = ConfigDict(strict=True, extra='allow')

    title: NonBlank
    description: str = ''


class Category(BaseModel):
    model_config = ConfigDict(strict=True, extra='allow')

    title: NonBlank
    description: str = ''
    scenarios: list[Scenario] = Field(min_length=1)


class Catalog(BaseModel):
    model_config = ConfigDict(strict=True)

    categories: list[Category] = Field(min_length=1)


class Assignment(BaseModel):
    model_config = ConfigDict(strict=True, populate_by_name=True)

    episode_id: str = Field(alias='episodeId')
    scenario_id: str = Field(alias='scenarioId')


class Placement(BaseModel):
    model_config = ConfigDict(strict=True)

    # An item that is no assignment places nothing; it does not cost the rest of the answer.
    assignments: list[Annotated[Assignment | Any, Field(union_mode='left_to_right')]]


EPISODE = Role('episode', instructions('episode'), Episode)
CATALOG = Role('catalog', instructions('catalog'), Catalog)
ROUTER = Role('catalog.router', instructions('catalog.router'), Placement)


async def episode(dialogue: dict) -> Answer[dict]:
    """The acquiring task of one conversation, read from the whole chat: {acquiring, start, end, task, object} or
    {acquiring: false, reason}."""
    payload = {'events': catalog.events(dialogue)}
    return await ask(EPISODE, payload, accept=lambda reply: catalog.checked_episode(reply.model_dump(), dialogue))


async def propose(tasks: list[dict]) -> Answer[list[dict]]:
    """The categories and scenarios of the tasks ({task, object, count}: each distinct task once, with how many
    episodes have it), with the code's ids (catalog.taxonomy)."""
    return await ask(
        CATALOG,
        {'tasks': tasks},
        accept=lambda reply: catalog.taxonomy([c.model_dump() for c in reply.categories]),
        timeout=PROPOSING,
    )


async def place(scenarios: list[dict], episodes: list[dict]) -> Answer[list[tuple[str, str]]]:
    """(episode, scenario) for each episode ({id, task, object, opening}) the router placed in a known scenario or in
    catalog.NONE; asked again when it places fewer than PLACED of them."""
    known_episodes = {item['id'] for item in episodes}
    known_scenarios = {item['id'] for item in scenarios} | {catalog.NONE}

    def placed(reply: Placement) -> list[tuple[str, str]]:
        found = [
            (item.episode_id, item.scenario_id)
            for item in reply.assignments
            if isinstance(item, Assignment)
            and item.episode_id in known_episodes
            and item.scenario_id in known_scenarios
        ]
        if len({episode for episode, _ in found}) < PLACED * len(known_episodes):
            raise ValueError('place every episode in a scenario or in none')
        return found

    return await ask(ROUTER, {'scenarios': scenarios, 'episodes': episodes}, accept=placed)
