import asyncio
import threading
import unittest

from lab.jobs import STOPPED, BusyError, Jobs, message


class JobsTests(unittest.IsolatedAsyncioTestCase):
    async def test_upload_reserves_same_owner_as_background_commands(self) -> None:
        jobs = Jobs()
        entered, release = asyncio.Event(), asyncio.Event()

        async def upload(progress) -> int:
            entered.set()
            await release.wait()
            return 2

        task = asyncio.create_task(jobs.perform('logs', upload))
        await entered.wait()
        with self.assertRaises(BusyError):
            jobs.start('sources', upload)
        release.set()
        self.assertEqual(await task, 2)
        self.assertFalse(jobs.state['running'])

    async def test_cancelled_thread_finishes_computation_without_committing(self) -> None:
        jobs = Jobs()
        entered, release, finished = threading.Event(), threading.Event(), threading.Event()
        commits = []

        def collect() -> str:
            entered.set()
            release.wait(timeout=5)
            finished.set()
            return 'old sources'

        async def work(progress) -> None:
            result = await asyncio.to_thread(collect)
            commits.append(result)

        jobs.start('sources', work)
        await asyncio.to_thread(entered.wait, 2)
        await jobs.stop()
        self.assertEqual(jobs.state['error'], STOPPED)
        self.assertFalse(jobs.state['running'])

        async def replacement(progress) -> None:
            commits.append('new sources')

        await jobs.perform('sources', replacement)
        release.set()
        await asyncio.to_thread(finished.wait, 2)
        await asyncio.sleep(0)
        self.assertEqual(commits, ['new sources'])

    async def test_stop_before_task_started_releases_owner(self) -> None:
        jobs = Jobs()
        started = []

        async def work(progress) -> None:
            started.append(True)

        jobs.start('cards', work)
        await jobs.stop()
        self.assertFalse(jobs.state['running'])
        self.assertEqual(jobs.state['error'], STOPPED)
        self.assertEqual(started, [])
        await jobs.perform('cards', work)
        self.assertEqual(started, [True])

    async def test_error_is_visible_and_owner_is_released(self) -> None:
        jobs = Jobs()

        async def work(progress) -> None:
            raise ValueError('broken export')

        with self.assertRaisesRegex(ValueError, 'broken export'):
            await jobs.perform('logs', work)
        self.assertFalse(jobs.state['running'])
        self.assertEqual(jobs.state['error'], 'broken export')

    async def test_cancelled_upload_request_releases_owner_before_worker_starts(self) -> None:
        jobs = Jobs()
        started = []

        async def work(progress) -> None:
            started.append(True)

        request = asyncio.create_task(jobs.perform('logs', work))
        await asyncio.sleep(0)
        request.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await request
        self.assertFalse(jobs.state['running'])
        self.assertEqual(jobs.state['error'], STOPPED)
        self.assertEqual(started, [])


if __name__ == '__main__':
    unittest.main()


class JobMessageTests(unittest.TestCase):
    def test_errors_of_a_task_group_are_told_in_their_own_words(self) -> None:
        group = ExceptionGroup('unhandled errors in a TaskGroup', [ValueError('Нет кода агента.')])
        self.assertEqual(message(group), 'Нет кода агента.')
        twice = ExceptionGroup('x', [ValueError('Один.'), ExceptionGroup('y', [ValueError('Один.'), KeyError('k')])])
        self.assertEqual(message(twice), "Один.; 'k'")
        self.assertEqual(message(RuntimeError()), 'RuntimeError')
