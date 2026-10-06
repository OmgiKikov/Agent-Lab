"""One owner of the long work of an agent: it starts a task (storage.tasks), gives it its progress and its stop, and
takes up again the tasks a process before it left running (recover). A screen shows what is kept of a task, never what
lives only here: here is only the coroutine that does the work.

A stop is a person's: the task ends stopped and keeps its finished parts, so the same work started again continues it.
Closing the Lab (a deploy, a restart) is not a stop: the work is cancelled and its task stays running, for the next
process to continue."""

import asyncio
import contextlib
import contextvars
import time
from collections.abc import Awaitable, Callable, Mapping
from typing import Any

from .flows import Progress, error_text
from .storage import db, tasks

Work = Callable[[Progress], Awaitable[Any]]
STOPPED = 'Остановлено'
INTERRUPTED = 'Прервано перезапуском Lab. Запустите снова.'
STALLED = (
    'Задача прерывалась при каждом перезапуске Lab и не успевала ничего сделать: она остановлена, чтобы не повторять '
    'сбой. Запустите её снова.'
)
BUSY = 'Сейчас идёт другая задача. Дождитесь её или остановите.'
LOST = 'Задача закончилась, но её конец не записался. Запустите её снова.'
PACE = 0.25  # seconds between two writes of a task's progress; the last value waits out the pause and is written


class BusyError(RuntimeError):
    pass


def view(task: dict | None) -> dict:
    """A task as the screens read it: what it is, whether it runs, how it ended (a stop as STOPPED), how far it got,
    when this stretch of it started, how many times a restart took it up, how many finished parts it keeps, and what it
    was started with."""
    if task is None:
        return {'kind': None, 'running': False, 'error': None, 'progress': {}, 'startedAt': None}
    return {
        'id': task['id'],
        'kind': task['kind'],
        'running': task['status'] == tasks.RUNNING,
        'error': STOPPED if task['status'] == tasks.STOPPED else task['error'],
        'progress': task['progress'],
        'startedAt': task['startedAt'],
        'resumed': task['resumed'],
        'kept': task['kept'],
        'input': task['input'],
    }


class Jobs:
    def __init__(self) -> None:
        self._task: asyncio.Task | None = None
        self._current: tasks.Current | None = None

    @property
    def state(self) -> dict:
        """The task of the agent started last, as kept."""
        return view(tasks.latest())

    def _launch(
        self,
        kind: str,
        work: Work,
        propagate: bool,
        given: dict | None = None,
        fingerprint: str | None = None,
        task_id: str | None = None,
        resumed: dict | None = None,
    ) -> tuple[asyncio.Task, dict]:
        if self._task is not None and not self._task.done():
            raise BusyError(BUSY)
        self._settle()
        if resumed is None:
            try:
                record = tasks.begin(kind, given or {}, fingerprint, task_id)
            except tasks.Busy:
                raise BusyError(BUSY) from None
            tasks.report(record['id'], {'message': 'Запускаем…'})
        else:
            record = resumed
        current = tasks.Current(record['id'])
        progress = Paced(record['id'])
        task = asyncio.get_running_loop().create_task(self._body(work, current, progress, propagate))
        progress.task = task
        self._task, self._current = task, current
        return task, record

    @staticmethod
    async def _body(work: Work, current: tasks.Current, progress: 'Paced', propagate: bool) -> Any:
        tasks.CURRENT.set(current)
        try:
            result = await work(progress)
        except asyncio.CancelledError:
            last = progress.last()  # no write of progress may come after the work, also when the Lab closes
            if not current.closing:
                tasks.end(current.id, tasks.STOPPED, None, last)
            if propagate:
                raise
        except Exception as error:
            tasks.end(current.id, tasks.FAILED, error_text(error), progress.last())
            if propagate:
                raise
        else:
            tasks.end(current.id, tasks.DONE, None, progress.last())
            return result

    def start(
        self,
        kind: str,
        work: Work,
        *,
        given: dict | None = None,
        fingerprint: str | None = None,
        task_id: str | None = None,
    ) -> dict:
        """Long work in the background: the same work (an equal fingerprint) a stop or a failure left continues, with
        the finished parts it kept (continued, kept)."""
        _, record = self._launch(kind, work, False, given, fingerprint, task_id)
        return {'ok': True, 'task': record['id'], 'continued': record['continued'], 'kept': record['kept']}

    async def perform(self, kind: str, work: Work) -> Any:
        """Await a command while reserving the same owner as background jobs."""
        task, record = self._launch(kind, work, propagate=True)
        current = self._current
        try:
            return await task
        finally:
            if self._task is task and task.cancelled() and current is not None and not current.closing:
                self._stopped(record['id'])

    def recover(self, kinds: Mapping[str, Callable[[dict], Work]]) -> list[dict]:
        """The tasks a process before this one left running, each taken up again from its kind and input (kinds); one
        whose kind cannot be (its request went with the process) or that stalled (tasks.resume) ends failed, saying
        why. The tasks taken up."""
        taken = []
        for record in tasks.running():
            make = kinds.get(record['kind'])
            if make is None:
                tasks.end(record['id'], tasks.FAILED, INTERRUPTED)
            elif not tasks.resume(record['id']):
                tasks.end(record['id'], tasks.FAILED, STALLED)
            else:
                self._launch(record['kind'], make(record['input']), False, resumed=tasks.get(record['id']))
                taken.append(record)
        return taken

    async def stop(self) -> None:
        task = self._task
        if task is None or task.done():
            self._settle()
            raise BusyError('Задача уже закончилась.')
        current = self._current
        if not task.cancelling():
            task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        finally:
            # A task cancelled before its first instruction never executes body().
            if current is not None and self._task is task:
                self._stopped(current.id)

    async def close(self) -> None:
        """The Lab closes: the work is cancelled and its task stays running, for the next process to continue."""
        task, current = self._task, self._current
        if task is None or task.done() or current is None:
            return
        current.closing = True
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError, Exception):  # the work's own end is not the closing Lab's
            await task

    def _settle(self) -> None:
        """The task this owner ran is over, yet kept as running: its end could not be written (storage failed). It
        ends failed, saying so, and the agent is no longer busy. A Lab closing never gets here: it starts no work."""
        task, current = self._task, self._current
        if task is None or not task.done() or current is None or current.closing:
            return
        record = tasks.get(current.id)
        if record is not None and record['status'] == tasks.RUNNING:
            tasks.end(current.id, tasks.FAILED, LOST)

    @staticmethod
    def _stopped(task_id: str) -> None:
        record = tasks.get(task_id)
        if record is not None and record['status'] == tasks.RUNNING:
            tasks.end(task_id, tasks.STOPPED)


class Paced:
    """The progress of a task (flows.Progress), written to it at most every PACE seconds: the last value waits out the
    pause and is written then, outside any transaction its caller might hold. Nothing is written while the task is
    being cancelled."""

    def __init__(self, task_id: str) -> None:
        self.task_id = task_id
        self.task: asyncio.Task | None = None
        self._at = 0.0
        self._pending: dict | None = None
        self._timer: asyncio.TimerHandle | None = None
        self._outside = contextvars.copy_context()

    def __call__(self, **values: Any) -> None:
        if self.task is not None and self.task.cancelling():
            return
        self._pending = values
        wait = PACE - (time.monotonic() - self._at)
        if wait <= 0:
            self._write()
        elif self._timer is None:
            self._timer = asyncio.get_running_loop().call_later(wait, self._write, context=self._outside)

    def last(self) -> dict | None:
        """The value not written yet, for the task's end to write; no write comes after."""
        if self._timer is not None:
            self._timer.cancel()
            self._timer = None
        pending, self._pending = self._pending, None
        return pending

    def _write(self) -> None:
        self._timer = None
        if self._pending is not None:
            values, self._pending = self._pending, None
            self._at = time.monotonic()
            tasks.report(self.task_id, values)


class PerAgent:
    """One owner of long work per agent (the database the request works in, storage.db.AGENT): agents are checked in
    parallel, and each screen sees only its own agent's work. Same interface as Jobs."""

    def __init__(self) -> None:
        self._owners: dict[str, Jobs] = {}

    def _jobs(self) -> Jobs:
        return self._owners.setdefault(str(db.AGENT.get() or ''), Jobs())

    @property
    def state(self) -> dict:
        return self._jobs().state

    def start(self, kind: str, work: Work, **kept: Any) -> dict:
        return self._jobs().start(kind, work, **kept)

    async def perform(self, kind: str, work: Work) -> Any:
        return await self._jobs().perform(kind, work)

    def recover(self, kinds: Mapping[str, Callable[[dict], Work]]) -> list[dict]:
        return self._jobs().recover(kinds)

    async def stop(self) -> None:
        await self._jobs().stop()

    async def close(self) -> None:
        for owner in self._owners.values():
            await owner.close()
