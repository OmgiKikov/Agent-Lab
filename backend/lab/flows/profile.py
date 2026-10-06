"""The profile of the agent under test (domain/profile.py), kept in the agent's database. The agent the Lab was first
made for, and a Lab without agents, start from the profile shipped for it; any other agent is described by a person
before its catalog and cards are built."""

import json
from pathlib import Path

from .. import storage
from ..domain import profile
from ..storage import db, registry

PROFILE = 'profile.json'
SHIPPED = Path(__file__).resolve().parents[1] / 'agents/profiles' / f'{registry.FIRST["id"]}.json'
MISSING = (
    'Опишите агента в его профиле: чем он занимается, что в его домен входит и что нет, какие номера называют '
    'его клиенты. По профилю разбираются разговоры и строятся карточки.'
)


def current() -> dict:
    """The agent's profile; a RuntimeError when the agent has none yet."""
    saved = storage.documents.load(PROFILE)
    if saved:
        return profile.checked(saved)
    if db.AGENT.get() in (None, registry.db_of(registry.FIRST['id'])):
        return profile.checked(json.loads(SHIPPED.read_text(encoding='utf-8')))
    raise RuntimeError(MISSING)


def save(value: object) -> dict:
    """The profile a person wrote, checked (a ValueError says what is wrong) and kept."""
    found = profile.checked(value)
    storage.documents.save(PROFILE, found)
    return found
