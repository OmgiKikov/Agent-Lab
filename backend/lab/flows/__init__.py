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


def error_text(error: BaseException) -> str:
    """What went wrong, in the words of the error itself: a task group's errors are told by their own messages, each
    once, never as «unhandled errors in a TaskGroup»."""
    return '; '.join(dict.fromkeys(str(leaf) or type(leaf).__name__ for leaf in _leaves(error)))


def _leaves(error: BaseException) -> list[BaseException]:
    if isinstance(error, BaseExceptionGroup):
        return [leaf for child in error.exceptions for leaf in _leaves(child)]
    return [error]
