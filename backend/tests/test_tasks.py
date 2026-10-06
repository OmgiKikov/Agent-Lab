"""Long work kept as it goes (storage.tasks, jobs, api.work): a restart or a deploy in the middle of it is a pause, a
person's stop keeps what was paid for, and the same start continues it."""

import asyncio
import json
import unittest
from unittest.mock import AsyncMock, patch

import support
from test_tone import POLICY
from test_tone_followthrough import judged

from lab import models, storage
from lab.api import work
from lab.flows import conversations, tone
from lab.jobs import INTERRUPTED, LOST, STALLED, STOPPED, Jobs
from lab.storage import tasks


def inside(task_id: str):
    """The code runs in this task, as jobs runs a task's work."""
    token = tasks.CURRENT.set(tasks.Current(task_id))
    return lambda: tasks.CURRENT.reset(token)


async def until(condition, seconds=5.0):
    for _ in range(int(seconds / 0.005)):
        if condition():
            return
        await asyncio.sleep(0.005)
    raise AssertionError('the condition did not come true')


class TaskStorageTests(unittest.TestCase):
    def setUp(self):
        support.lab(self)

    def test_one_task_runs_at_a_time(self):
        tasks.begin('tone-check', {})
        with self.assertRaises(tasks.Busy):
            tasks.begin('run', {})

    def test_the_first_value_kept_under_a_key_stays(self):
        task = tasks.begin('tone-check', {})
        leave = inside(task['id'])
        self.assertEqual(tasks.keep('dialogue:1', {'verdict': 'first'}), {'verdict': 'first'})
        self.assertEqual(tasks.keep('dialogue:1', {'verdict': 'second'}), {'verdict': 'first'})
        self.assertEqual(tasks.steps(), {'dialogue:1': {'verdict': 'first'}})
        leave()
        self.assertEqual(tasks.steps(), {})  # outside a task nothing is kept
        self.assertEqual(tasks.keep('dialogue:2', 1), 1)

    def test_a_stopped_task_continues_only_as_the_same_work_and_only_the_latest(self):
        first = tasks.begin('tone-check', {'count': 3}, 'same')
        leave = inside(first['id'])
        tasks.keep('dialogue:1', 'judged')
        leave()
        tasks.end(first['id'], tasks.STOPPED)
        again = tasks.begin('tone-check', {'count': 3}, 'same')
        self.assertEqual((again['id'], again['continued'], again['kept']), (first['id'], True, 1))
        tasks.end(again['id'], tasks.FAILED, 'model down')
        other = tasks.begin('tone-check', {'count': 5}, 'other')
        self.assertFalse(other['continued'])
        # Other work of the kind started: the earlier task can never be continued, so its steps went.
        self.assertEqual(tasks.get(first['id'])['kept'], 0)
        tasks.end(other['id'], tasks.STOPPED)
        self.assertFalse(tasks.begin('tone-check', {'count': 3}, 'same')['continued'])

    def test_a_task_done_lets_its_steps_go(self):
        task = tasks.begin('tone-check', {}, 'same')
        leave = inside(task['id'])
        tasks.keep('dialogue:1', 'judged')
        leave()
        tasks.end(task['id'], tasks.DONE, None, {'done': 1, 'total': 1})
        found = tasks.get(task['id'])
        self.assertEqual((found['status'], found['kept'], found['progress']), ('done', 0, {'done': 1, 'total': 1}))
        self.assertFalse(tasks.begin('tone-check', {}, 'same')['continued'])

    def test_a_persons_continue_is_no_restart(self):
        task = tasks.begin('tone-check', {}, 'same')
        tasks.resume(task['id'])
        tasks.end(task['id'], tasks.STOPPED)
        self.assertEqual(tasks.begin('tone-check', {}, 'same')['resumed'], 0)

    def test_restarts_that_find_no_new_step_give_the_task_up(self):
        task = tasks.begin('tone-check', {})
        self.assertEqual([tasks.resume(task['id']) for _ in range(3)], [True, True, True])
        leave = inside(task['id'])
        tasks.keep('dialogue:1', 'judged')  # progress made: the count starts again
        leave()
        self.assertEqual([tasks.resume(task['id']) for _ in range(5)], [True, True, True, False, False])


class JobLifeTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        support.lab(self)
        self.jobs = Jobs()
        self.addAsyncCleanup(self.jobs.close)

    async def test_a_stop_keeps_the_finished_parts_and_the_same_start_continues(self):
        entered, seen = asyncio.Event(), []

        async def work_(progress):
            seen.append(dict(tasks.steps()))
            tasks.keep('dialogue:1', 'judged')
            entered.set()
            await asyncio.Event().wait()

        first = self.jobs.start('tone-check', work_, given={'count': 2}, fingerprint='same')
        self.assertEqual((first['continued'], first['kept']), (False, 0))
        await entered.wait()
        await self.jobs.stop()
        state = self.jobs.state
        self.assertEqual((state['running'], state['error'], state['kept']), (False, STOPPED, 1))
        entered.clear()
        again = self.jobs.start('tone-check', work_, given={'count': 2}, fingerprint='same')
        self.assertEqual((again['task'], again['continued'], again['kept']), (first['task'], True, 1))
        await entered.wait()
        self.assertEqual(seen, [{}, {'dialogue:1': 'judged'}])

    async def test_closing_leaves_the_task_running_and_the_next_process_takes_it_up(self):
        entered, finished = asyncio.Event(), asyncio.Event()

        async def first(progress):
            tasks.keep('part:1', 1)
            progress(message='Проверяем', done=1, total=2)
            entered.set()
            await asyncio.Event().wait()

        self.jobs.start('tone-check', first, given={'count': 2})
        await entered.wait()
        await self.jobs.close()
        kept = tasks.latest()
        self.assertEqual((kept['status'], kept['kept']), ('running', 1))
        self.assertEqual(kept['progress'], {'message': 'Проверяем', 'done': 1, 'total': 2})

        async def rest(progress):
            self.assertEqual(tasks.steps(), {'part:1': 1})
            tasks.keep('part:2', 2)
            finished.set()

        later = Jobs()
        self.addAsyncCleanup(later.close)
        taken = later.recover({'tone-check': lambda given: rest})
        self.assertEqual([task['id'] for task in taken], [kept['id']])
        await finished.wait()
        await until(lambda: not later.state['running'])
        state = later.state
        self.assertEqual((state['error'], state['resumed']), (None, 1))
        self.assertEqual(tasks.get(kept['id'])['status'], 'done')

    async def test_work_a_request_awaited_is_not_taken_up_and_says_why(self):
        tasks.begin('logs', {})
        Jobs().recover(work.RESUME)
        state = self.jobs.state
        self.assertEqual((state['running'], state['error']), (False, INTERRUPTED))

    async def test_work_that_dies_with_every_restart_is_given_up(self):
        task = tasks.begin('sources', {})
        for _ in range(3):
            tasks.resume(task['id'])
        self.assertEqual(Jobs().recover(work.RESUME), [])
        self.assertEqual(self.jobs.state['error'], STALLED)

    async def test_progress_is_kept_paced_and_its_last_value_is_never_lost(self):
        writes = []
        report = tasks.report

        def counted(task_id, values):
            writes.append(values)
            report(task_id, values)

        async def chatty(progress):
            for done in range(1, 201):
                progress(done=done, total=200)
                await asyncio.sleep(0)

        with patch.object(tasks, 'report', counted):
            await self.jobs.perform('tone-check', chatty)
        self.assertLess(len(writes), 20)
        self.assertEqual(self.jobs.state['progress'], {'done': 200, 'total': 200})

    async def test_a_task_whose_end_was_not_written_does_not_keep_the_agent_busy(self):
        end = tasks.end
        calls = []

        def broken_once(*args, **kwargs):
            calls.append(args)
            if len(calls) == 1:
                raise RuntimeError('database is locked')
            return end(*args, **kwargs)

        async def quick(progress):
            pass

        with patch.object(tasks, 'end', broken_once):
            first = self.jobs.start('sources', quick)
            await until(lambda: len(calls) == 1)
            await asyncio.sleep(0)
            self.assertTrue(self.jobs.state['running'])  # storage still says so
            again = self.jobs.start('sources', quick)
        self.assertNotEqual(again['task'], first['task'])
        self.assertEqual(tasks.get(first['task'])['error'], LOST)
        await until(lambda: not self.jobs.state['running'])

    async def test_a_screen_reads_the_task_from_storage_not_from_the_owner(self):
        async def failing(progress):
            progress(message='Читаем')
            raise ValueError('broken export')

        with self.assertRaises(ValueError):
            await self.jobs.perform('logs', failing)
        fresh = Jobs().state
        self.assertEqual((fresh['kind'], fresh['running'], fresh['error']), ('logs', False, 'broken export'))


class DurableToneCheckTests(unittest.IsolatedAsyncioTestCase):
    """A check of tone of voice over four conversations, cut after two by a deploy or a stop."""

    async def asyncSetUp(self):
        support.serve(self)
        lines = [
            json.dumps(
                {
                    'id': f'd{index}',
                    'messages': [
                        {'role': 'user', 'content': f'Вопрос {index}'},
                        {'role': 'assistant', 'content': f'Ответ {index}'},
                    ],
                },
                ensure_ascii=False,
            )
            for index in range(1, 5)
        ]
        await self.client.post('/api/logs?name=four.jsonl', content='\n'.join(lines))
        await self.client.post('/api/tone-of-voice/policy', json={'text': POLICY})
        with patch.object(models, 'chat', AsyncMock(side_effect=AssertionError('coded policy must not call a model'))):
            await self.client.post('/api/tone-of-voice/criteria')
            await until(lambda: not self.jobs.state['running'])
        self.judged: list[str] = []
        self.release = asyncio.Event()
        self.two = asyncio.Event()
        self.verdict = judged('PASS')

    async def judge(self, dialogue, topic):
        """Judges two conversations, then waits to be released."""
        if len(self.judged) >= 2:
            self.two.set()
            await self.release.wait()
        self.judged.append(dialogue['id'])
        return await self.verdict(dialogue, topic)

    async def start(self, rule_ids=('pronouns', 'simple_language')):
        response = await self.client.post('/api/tone-of-voice/check', json={'ruleIds': list(rule_ids), 'count': 4})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    async def test_a_deploy_in_the_middle_pays_only_for_the_rest(self):
        with patch.object(conversations, 'judge_dialogue', side_effect=self.judge):
            started = await self.start()
            await self.two.wait()
            await self.jobs.close()  # the Lab goes down mid-check
            self.assertEqual(tasks.get(started['task'])['status'], 'running')
            self.assertEqual(tasks.get(started['task'])['kept'], 2)
            self.release.set()
            later = Jobs()
            self.addAsyncCleanup(later.close)
            later.recover(work.RESUME)
            await until(lambda: not later.state['running'])
        self.assertIsNone(later.state['error'])
        self.assertEqual(sorted(self.judged), ['d1', 'd2', 'd3', 'd4'])  # each conversation judged once
        result = storage.documents.load(tone.RESULT)
        self.assertEqual(result['checkId'], started['task'])
        self.assertEqual(sorted(row['dialogueId'] for row in result['results']), ['d1', 'd2', 'd3', 'd4'])
        self.assertEqual([line['id'] for line in storage.history.lines('tone')], [started['task']])

    async def test_a_restart_after_the_check_was_published_never_publishes_it_twice(self):
        with patch.object(conversations, 'judge_dialogue', side_effect=judged('PASS')):
            started = await self.start()
            await until(lambda: not self.jobs.state['running'])
        # The process died after publishing, before the task was written done.
        with storage.transaction(), storage.db.connect() as connection:
            connection.execute("UPDATE tasks SET status = 'running' WHERE id = ?", (started['task'],))
        later = Jobs()
        self.addAsyncCleanup(later.close)
        never = AsyncMock(side_effect=AssertionError('a published check is not judged again'))
        with patch.object(conversations, 'judge_dialogue', never):
            later.recover(work.RESUME)
            await until(lambda: not later.state['running'])
        self.assertIsNone(later.state['error'])
        self.assertEqual(len(storage.history.lines('tone')), 1)

    async def test_stop_keeps_what_was_judged_and_the_same_start_continues_it(self):
        with patch.object(conversations, 'judge_dialogue', side_effect=self.judge):
            started = await self.start()
            await self.two.wait()
            await self.client.post('/api/job/stop')
            state = (await self.client.get('/api/state')).json()['job']
            self.assertEqual((state['error'], state['kept'], state['continuable']), (STOPPED, 2, True))
            self.release.set()
            again = await self.start()
            self.assertEqual((again['task'], again['continued'], again['kept']), (started['task'], True, 2))
            await until(lambda: not self.jobs.state['running'])
        self.assertIsNone(self.jobs.state['error'])
        self.assertEqual(sorted(self.judged), ['d1', 'd2', 'd3', 'd4'])
        self.assertEqual(len(storage.documents.load(tone.RESULT)['results']), 4)

    async def test_other_criteria_make_other_work(self):
        with patch.object(conversations, 'judge_dialogue', side_effect=self.judge):
            await self.start()
            await self.two.wait()
            await self.client.post('/api/job/stop')
            self.release.set()
            other = await self.start(rule_ids=('pronouns',))
            self.assertEqual((other['continued'], other['kept']), (False, 0))
            await until(lambda: not self.jobs.state['running'])
        self.assertEqual(len(self.judged), 2 + 4)

    async def test_criteria_clarified_after_the_stop_make_other_work(self):
        with patch.object(conversations, 'judge_dialogue', side_effect=self.judge):
            await self.start()
            await self.two.wait()
            await self.client.post('/api/job/stop')
        self.assertTrue((await self.client.get('/api/state')).json()['job']['continuable'])
        draft = storage.documents.load(tone.DRAFT)
        response = await self.client.post(
            '/api/tone-of-voice/clarification',
            json={'revision': draft['revision'], 'ruleId': 'pronouns', 'text': '«Вы» с прописной буквы тоже ошибка.'},
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertFalse((await self.client.get('/api/state')).json()['job']['continuable'])

    async def test_other_judges_make_other_work(self):
        with patch.object(conversations, 'judge_dialogue', side_effect=self.judge):
            await self.start()
            await self.two.wait()
            await self.client.post('/api/job/stop')
        self.assertTrue(work.continuable(tasks.latest()))
        support.use(self, support.changed(self.settings, model='another-model'))
        self.assertFalse(work.continuable(tasks.latest()))


if __name__ == '__main__':
    unittest.main()
