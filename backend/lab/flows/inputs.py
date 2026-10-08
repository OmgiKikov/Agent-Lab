"""The Lab's inputs, and what a new one resets: the export of conversations, the agent's code (its prompts and tools)
and the rules of communication.

Replacing an input clears, in the same transaction, only what was derived from it. A new export clears the results of
both checks and the deck; their saved checks stay in their histories, and the criteria of both wait for the next check
(tone of voice's in their draft, Точность's in checks.CODE_CRITERIA). Changed rules of communication clear tone of
voice's criteria, its result and a deck built from it; changed code of the agent clears Точность's result, its kept
criteria and a deck built from it; code read again unchanged clears nothing, wherever its prompts now stand in their
files. Runs and the answers people gave stay.
"""

import asyncio
import hashlib
from collections.abc import Collection

from .. import storage
from ..agents import sources as agent_sources
from ..domain import accuracy, checks, export, tone
from . import connection

SOURCES = 'sources.json'  # the agent's prompts and tools, and the rules of communication beside them
# When the agent's code was read last, from which folder (the setting as the person wrote it) and which prompts were
# over the planner's budget (overBudget, path:line): written with the sources, so «Агент» names the read that
# succeeded, not the one asked for.
SOURCES_READ = 'sources-read.json'
TONE_DRAFT = 'tone-of-voice-criteria.json'  # the criteria of tone of voice, collected from the rules


def sources() -> list[dict]:
    """The sources read last: the agent's prompts and tools, and the rules of communication."""
    return storage.documents.load(SOURCES, []) or []


def drop_deck(changed: Collection[str]) -> None:
    """The scenarios go with the result or the criteria of the check they were built from (changed); a deck from
    before decks named their check goes with any, one built without a check (None) with none: it carries no criteria.
    Written in the caller's transaction."""
    deck = storage.documents.load(checks.DECK)
    if changed and deck and ('check' not in deck or deck['check'] in changed):
        storage.documents.save(checks.DECK, None)


def replace_export(dialogues: list[dict], name: str | None = None, report: dict | None = None) -> int:
    """The new export with its file name and how its rows were read (report), and what it resets. A saved check never
    names the previous file."""
    with storage.transaction():
        result = storage.documents.load(checks.result(checks.CODE))
        if result and result.get('topics'):
            # Точность's criteria wait for its next check, which sorts the new conversations into the same topics;
            # without a result, the criteria kept already stay.
            storage.documents.save(checks.CODE_CRITERIA, accuracy.criteria_of(result))
        storage.dialogues.replace(dialogues, name, report)
        _clear(checks.RESULTS)
        # Every card is a customer of the previous export, a deck built without a check too.
        storage.documents.save(checks.DECK, None)
    return len(dialogues)


async def upload_export(name: str, data: bytes) -> dict:
    """An uploaded export read in a worker thread and committed whole: how many conversations it has, how many it
    had that a check cannot read (the agent wrote first, or never answered), and how many were quarantined because
    their text and the order column disagree; both are left out."""
    dialogues, skipped, quarantined = await asyncio.to_thread(export.read_export, name, data)
    report = {'skipped': skipped, 'quarantined': quarantined}
    return {'total': replace_export(dialogues, name, report), 'skipped': skipped, 'quarantined': len(quarantined)}


def replace_sources(items: list[dict], read: dict | None = None) -> None:
    """New sources, and what the ones that changed reset. read: when and from where the agent's code was read, written
    in the same transaction, so it never names the previous read."""
    with storage.transaction():
        before = sources()
        changed = [check for check, part in _SOURCES_OF.items() if _content(part(before)) != _content(part(items))]
        if checks.CODE in changed:
            storage.documents.save(checks.CODE_CRITERIA, None)
        storage.documents.save(SOURCES, items)
        if read is not None:
            storage.documents.save(SOURCES_READ, read)
        if checks.TONE in changed:
            storage.documents.save(TONE_DRAFT, None)
        _clear(changed)


async def read_code() -> list[dict]:
    """The agent's prompts and tools read again from its folder (in a worker thread). The rules of communication are a
    person's document, not the agent's code: reading the code keeps them."""
    folder = connection.settings()['repo']
    collected, over_budget = await asyncio.to_thread(agent_sources.collect, connection.repo())
    policy = [source for source in sources() if source['kind'] == tone.KIND]
    replace_sources([*collected, *policy], {'readAt': storage.now(), 'repo': folder, 'overBudget': over_budget})
    return collected


def save_policy(name: str, text: str) -> None:
    """The person's rules of communication, beside the agent's code."""
    rules = tone.policy(name.strip(), text)
    replace_sources([*(source for source in sources() if source['kind'] != tone.KIND), rules])


def _clear(changed: Collection[str]) -> None:
    """The results of the checks whose inputs changed, and a deck built from them. The names stay, set to nothing: a
    repeated legacy import must not resurrect results cleared on purpose."""
    for check in changed:
        storage.documents.save(checks.result(check), None)
    drop_deck(changed)


def _tone_policy(items: list[dict]) -> list[dict]:
    """The rules of communication among the sources."""
    return [item for item in items if item.get('kind') == tone.KIND]


def _code(items: list[dict]) -> list[dict]:
    """The agent's prompts and tools among the sources: everything but the rules of communication."""
    return [item for item in items if item.get('kind') != tone.KIND]


# The sources each check's criteria come from.
_SOURCES_OF = {checks.TONE: _tone_policy, checks.CODE: _code}


def _content(items: list[dict]) -> list[tuple]:
    """What the criteria of a check stand on: each source's id, kind and text. Not where it was found nor what it is
    called: a prompt that moved down a line (`origin` is path:line) or rules saved under another name are the same
    sources. The id stays: criteria name their source by it (sourceId)."""
    return [(item.get('id'), item.get('kind'), _text_hash(item)) for item in items]


def _text_hash(item: dict) -> str:
    return item.get('sha256') or hashlib.sha256(str(item.get('content')).encode()).hexdigest()
