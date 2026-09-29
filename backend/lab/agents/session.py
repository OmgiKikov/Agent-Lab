"""An opened agent, with cleanup joined before its caller can finish or be cancelled."""

import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from .http import HttpAgent


@asynccontextmanager
async def session(agent: HttpAgent) -> AsyncIterator[HttpAgent]:
    cancellation: asyncio.CancelledError | None = None
    try:
        await agent.open()
        yield agent
    except asyncio.CancelledError as error:
        cancellation = error
        raise
    finally:
        # open() may have acquired a process before failing. Cleanup owns its own task,
        # so repeated cancellation of the caller cannot interrupt it.
        close_task = asyncio.create_task(agent.close())
        while not close_task.done():
            try:
                await asyncio.shield(close_task)
            except asyncio.CancelledError as error:
                cancellation = error
            except Exception:
                break  # the failed close task's exception is retrieved below
        try:
            close_task.result()
        except Exception:
            if cancellation is None:
                raise
        if cancellation is not None:
            raise cancellation
