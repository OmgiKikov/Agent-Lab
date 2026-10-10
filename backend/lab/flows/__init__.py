"""The processes of the product: each one change the Lab makes, from its inputs to what it stores.

A process gathers roles (roles/), rules (domain/), the agent under test (agents/) and storage into one operation, and
only a process opens a transaction and decides what a change resets. An HTTP handler checks the input and calls it; a
job (jobs.py) gives it its progress and its stop.
"""

import hashlib
import json
from collections.abc import Callable
from typing import Any

# How a process tells what it is doing: progress(message=…, done=…, total=…) and whatever its screen reads.
Progress = Callable[..., None]


def same_work(**parts: Any) -> str:
    """What makes two starts of long work the same work, as one short string: a stopped task continues only when the
    work started again has the same (storage.tasks.begin)."""
    return hashlib.sha256(json.dumps(parts, ensure_ascii=False, sort_keys=True).encode()).hexdigest()[:32]


def sources_content(items: list[dict]) -> list[tuple]:
    """What the criteria of a check stand on: each source's id, kind and text. Not where it was found nor what it is
    called: a prompt that moved down a line (`origin` is path:line) or rules saved under another name are the same
    sources. The id stays: criteria name their source by it (sourceId)."""
    return [(item.get('id'), item.get('kind'), _text_hash(item)) for item in items]


def _text_hash(item: dict) -> str:
    return item.get('sha256') or hashlib.sha256(str(item.get('content')).encode()).hexdigest()


def error_text(error: BaseException) -> str:
    """What went wrong, in the words of the error itself: a task group's errors are told by their own messages, each
    once, never as «unhandled errors in a TaskGroup»."""
    return '; '.join(dict.fromkeys(str(leaf) or type(leaf).__name__ for leaf in _leaves(error)))


def _leaves(error: BaseException) -> list[BaseException]:
    if isinstance(error, BaseExceptionGroup):
        return [leaf for child in error.exceptions for leaf in _leaves(child)]
    return [error]
