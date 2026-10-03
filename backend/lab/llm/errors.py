import math
from datetime import UTC, datetime
from email.utils import parsedate_to_datetime

import httpx


class ModelError(RuntimeError):
    """A model or the model gateway gave no usable answer. The message is for the person; the rest is for the retry
    policy (llm.chat): the HTTP status the model refused with, whether asking again later may help, and the pause the
    model asked for (Retry-After, seconds)."""

    def __init__(
        self, message: str, *, status: int | None = None, retryable: bool = False, retry_after: float | None = None
    ) -> None:
        super().__init__(message)
        self.status = status
        self.retryable = retryable
        self.retry_after = retry_after


class MalformedAnswer(ModelError):
    """The model answered, but not in the agreed form: another answer may be well-formed (llm.structured)."""


def refused(prefix: str, response: httpx.Response) -> ModelError:
    """An error status: a busy (429) or failing (5xx) model may answer later, any other 4xx will not."""
    status = response.status_code
    return ModelError(
        f'{prefix} HTTP {status}',
        status=status,
        retryable=status == 429 or status >= 500,
        retry_after=_seconds(response.headers.get('Retry-After')),
    )


def _seconds(value: str | None) -> float | None:
    """Retry-After: a number of seconds or an HTTP date."""
    if not value:
        return None
    try:
        seconds = float(value)
    except ValueError:
        try:
            seconds = (parsedate_to_datetime(value) - datetime.now(UTC)).total_seconds()
        except (TypeError, ValueError):
            return None
    return max(0.0, seconds) if math.isfinite(seconds) else None
