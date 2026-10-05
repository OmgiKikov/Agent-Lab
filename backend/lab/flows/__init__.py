"""The processes of the product: each one change the Lab makes, from its inputs to what it stores.

A process gathers roles (roles/), rules (domain/), the agent under test (agents/) and storage into one operation, and
only a process opens a transaction and decides what a change resets. An HTTP handler checks the input and calls it; a
job (jobs.py) gives it its progress and its stop.
"""

from collections.abc import Callable

# How a process tells what it is doing: progress(message=…, done=…, total=…) and whatever its screen reads.
Progress = Callable[..., None]


def error_text(error: BaseException) -> str:
    """What went wrong, in the words of the error itself: a task group's errors are told by their own messages, each
    once, never as «unhandled errors in a TaskGroup»."""
    return '; '.join(dict.fromkeys(str(leaf) or type(leaf).__name__ for leaf in _leaves(error)))


def _leaves(error: BaseException) -> list[BaseException]:
    if isinstance(error, BaseExceptionGroup):
        return [leaf for child in error.exceptions for leaf in _leaves(child)]
    return [error]
