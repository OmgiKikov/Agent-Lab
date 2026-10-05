"""One owner for all long-running commands, including log uploads."""

import asyncio
from collections.abc import Awaitable, Callable
from typing import Any

from . import storage
from .flows import Progress, error_text

Work = Callable[[Progress], Awaitable[Any]]
STOPPED = 'Остановлено'


class BusyError(RuntimeError):
    pass


class Jobs:
    def __init__(self) -> None:
        # startedAt tells one task from the next of the same kind: a screen that saw neither run still says how the
        # newest one ended, and a failure it was told to hide is not hidden again when it comes back (TaskCard).
        self.state: dict = {'kind': None, 'running': False, 'error': None, 'progress': {}, 'startedAt': None}
        self._task: asyncio.Task | None = None

    def _launch(self, kind: str, work: Work, propagate: bool) -> asyncio.Task:
        if self.state['running']:
            raise BusyError('Сейчас идёт другая задача. Дождитесь её или остановите.')
        self.state.update(
            kind=kind, running=True, error=None, progress={'message': 'Запускаем…'}, startedAt=storage.now()
        )

        def progress(**values: Any) -> None:
            if not task.cancelling():
                self.state['progress'] = values

        async def body() -> Any:
            try:
                return await work(progress)
            except asyncio.CancelledError:
                self.state['error'] = STOPPED
                if propagate:
                    raise
            except Exception as error:
                self.state['error'] = error_text(error)
                if propagate:
                    raise
            finally:
                self.state['running'] = False

        task = asyncio.get_running_loop().create_task(body())
        self._task = task
        return task

    def start(self, kind: str, work: Work) -> dict:
        self._launch(kind, work, propagate=False)
        return {'ok': True}

    async def perform(self, kind: str, work: Work) -> Any:
        """Await a command while reserving the same owner as background jobs."""
        task = self._launch(kind, work, propagate=True)
        try:
            return await task
        finally:
            if self._task is task and task.cancelled() and self.state['running']:
                self.state.update(running=False, error=STOPPED)

    async def stop(self) -> None:
        if not self.state['running'] or self._task is None:
            raise BusyError('Задача уже закончилась.')
        task = self._task
        if not task.cancelling():
            task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        finally:
            # A task cancelled before its first instruction never executes body().
            if self._task is task and self.state['running']:
                self.state.update(running=False, error=STOPPED)

    async def close(self) -> None:
        if self.state['running']:
            await self.stop()


class PerAgent:
    """One owner of long work per agent (the database the request works in, storage.db.AGENT): agents are checked in
    parallel, and each screen sees only its own agent's work. Same interface as Jobs."""

    def __init__(self) -> None:
        self._owners: dict[str, Jobs] = {}

    def _jobs(self) -> Jobs:
        return self._owners.setdefault(str(storage.db.AGENT.get() or ''), Jobs())

    @property
    def state(self) -> dict:
        return self._jobs().state

    def start(self, kind: str, work: Work) -> dict:
        return self._jobs().start(kind, work)

    async def perform(self, kind: str, work: Work) -> Any:
        return await self._jobs().perform(kind, work)

    async def stop(self) -> None:
        await self._jobs().stop()

    async def close(self) -> None:
        for owner in self._owners.values():
            await owner.close()
