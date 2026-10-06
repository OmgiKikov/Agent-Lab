"""The Lab's inputs and what a new one resets: the exports of conversations, the agent's code (its prompts and tools)
and the rules of communication.

An export is added beside the others and resets nothing: a check is made of the export chosen for it. An export
removed takes with it, in the same transaction, the current result made of it (its saved check keeps the conversations
it judged) and the scenarios built from that result; Точность keeps its criteria for its next check
(checks.CODE_CRITERIA). Changed rules of communication clear tone of voice's criteria, its result and a deck built from
it; changed code of the agent clears Точность's result, its kept criteria and a deck built from it; code read again
unchanged clears nothing, wherever its prompts now stand in their files. Runs and the answers people gave stay.
"""

import asyncio
import hashlib
from collections.abc import Collection

from .. import storage
from ..agents import sources as agent_sources
from ..domain import accuracy, checks, export, tone
from . import connection, conversations

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
    """The scenarios go with the result or the criteria of the check they were built from (changed); a deck that names
    no check goes with any. Written in the caller's transaction."""
    deck = storage.documents.load(checks.DECK)
    if changed and (deck is None or deck.get('check') in (None, *changed)):
        storage.documents.save(checks.DECK, None)


def add_export(dialogues: list[dict], file: str | None, name: str | None = None, skipped: int = 0) -> dict:
    """A new export beside the others, under its name (the file's by default): nothing checked changes."""
    return storage.exports.add(dialogues, file, name, skipped)


async def upload_export(file: str, data: bytes, name: str | None = None) -> dict:
    """An uploaded file read in a worker thread and added whole as an export: its line, with how many conversations of
    the file a check cannot read (the agent wrote first, or never answered), which are left out (skipped)."""
    dialogues, skipped = await asyncio.to_thread(export.read_export, file, data)
    return add_export(dialogues, file, name, skipped)


def remove_export(export_id: str) -> dict:
    """An export and its conversations go, with the current result made of it and the scenarios built from that result;
    Точность keeps the criteria of its result for its next check. The export as it was; LookupError when it is gone."""
    with storage.transaction():
        removed = storage.exports.get(export_id)
        if removed is None:
            raise LookupError('Выгрузки уже нет.')
        made = {check: storage.documents.load(checks.result(check)) for check in checks.RESULTS}
        cleared = [check for check, result in made.items() if result and conversations.export_of(result) == export_id]
        code = made[checks.CODE]
        if checks.CODE in cleared and code.get('topics'):
            storage.documents.save(checks.CODE_CRITERIA, accuracy.criteria_of(code))
        storage.exports.remove(export_id)
        _clear(cleared)
    return removed


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
