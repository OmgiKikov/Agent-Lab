"""What the sections of the API share: the owner of long work of the app a request came to (jobs_of, Jobs), starting a
job (start) and an uploaded file read no further than its limit (uploaded)."""

from typing import Annotated

from fastapi import Depends, HTTPException, Request

from ..jobs import BusyError, PerAgent, Work


async def jobs_of(request: Request) -> PerAgent:
    """The owner of long work of the app the request came to (app.create): one per agent."""
    return request.app.state.jobs


Jobs = Annotated[PerAgent, Depends(jobs_of)]


def start(jobs: PerAgent, kind: str, work: Work) -> dict:
    """Long work started in the background; 409 while another task of the agent runs."""
    try:
        return jobs.start(kind, work)
    except BusyError as error:
        raise HTTPException(409, str(error)) from error


async def uploaded(request: Request, limit: int, advice: str) -> bytes:
    """The uploaded file: refused by its declared length before a byte is read, and never read past the limit; the
    refusal says what to do (advice)."""
    size = f'{limit / 1_000_000:g}'.replace('.', ',')
    message = f'Файл больше {size}\u00a0МБ. {advice}'
    try:
        declared = int(request.headers.get('content-length') or 0)
    except ValueError:
        declared = 0  # counted while reading
    if declared > limit:
        raise HTTPException(413, message)
    data = bytearray()
    async for chunk in request.stream():
        data += chunk
        if len(data) > limit:
            raise HTTPException(413, message)
    return bytes(data)
