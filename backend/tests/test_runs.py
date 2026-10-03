import asyncio
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from lab import simulate, store
from lab.jobs import Jobs
from lab.metric import metric


def card(key: str = 'card-1', text: str = 'question') -> dict:
    return {
        'id': key,
        'name': key,
        'topic': 'topic',
        'origin': 'log',
        'situation': 'situation',
        'opening': text,
        'criteria': [],
    }


class FakeAgent:
    version = 'v1'
    mocked = False

    def __init__(self) -> None:
        self.closed = False

    async def open(self) -> None:
        pass

    async def close(self) -> None:
        self.closed = True

    async def say(self, conversation_id: str, message: str, world: dict) -> dict:
        return {'text': 'answer', 'status': '202', 'ok': False, 'options': [], 'events': []}


class RunsTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.agent = FakeAgent()
        patches = [
            patch.object(store, 'DB', Path(directory.name) / 'lab.sqlite3'),
            patch.object(simulate.cards, 'deck', return_value=[card()]),
            patch.object(simulate.agents, 'configs', return_value={'test': {'name': 'Test'}}),
            patch.object(simulate.agents, 'create', return_value=self.agent),
        ]
        for mocked in patches:
            mocked.start()
            self.addCleanup(mocked.stop)

    async def test_run_progress_keeps_a_concurrent_human_review(self) -> None:
        entered, release = asyncio.Event(), asyncio.Event()

        async def evaluate(scenario: dict, item: dict) -> None:
            if scenario['id'] == 'card-2':
                entered.set()
                await release.wait()
            item.update(status='PASS', rules=[], model=f'actual-judge-{scenario["id"]}')

        with (
            patch.object(simulate.cards, 'deck', return_value=[card(), card('card-2')]),
            patch.object(simulate.judge, 'evaluate', side_effect=evaluate),
        ):
            task = asyncio.create_task(simulate.run('test'))
            await entered.wait()
            run_id = store.runs()[0]['id']
            store.set_review(run_id, 0, 'disagree')
            release.set()
            result = await task
        self.assertEqual(result['status'], 'done')
        self.assertTrue(result['finishedAt'])
        self.assertTrue(self.agent.closed)
        self.assertEqual(result['items'][0]['review'], 'disagree')
        self.assertEqual(result['metric']['human']['agree'], 0)
        self.assertIn('actual-judge-card-1', result['model'])
        self.assertIn('actual-judge-card-2', result['model'])

    async def test_rejudge_patches_a_current_record_instead_of_stale_snapshot(self) -> None:
        source = simulate.new_run('test', {'name': 'Test'}, '', 1, ['default'])
        item = simulate.new_item(card(), 'default', 1)
        item.update(status='FAIL', conversation=[{'role': 'agent', 'text': 'answer'}], review=None)
        source.update(items=[item], status='done')
        stale = store.create_run(source)
        entered, release = asyncio.Event(), asyncio.Event()

        async def evaluate(scenario: dict, item: dict) -> None:
            entered.set()
            await release.wait()
            item.update(status='FAIL')

        with patch.object(simulate.judge, 'evaluate', side_effect=evaluate):
            task = asyncio.create_task(simulate.rejudge(stale))
            await entered.wait()
            store.set_review(source['id'], 0, 'disagree')
            release.set()
            result = await task
        self.assertEqual(result['items'][0]['status'], 'FAIL')
        self.assertEqual(result['items'][0]['review'], 'disagree')
        self.assertTrue(result['rejudgedAt'])

    async def test_unexpected_failure_cancels_and_joins_sibling_before_close(self) -> None:
        entered = asyncio.Event()
        active = set()
        stopped = []

        async def say(conversation_id: str, message: str, world: dict) -> dict:
            if message == 'bad':
                await entered.wait()
                raise RuntimeError('unexpected agent failure')
            active.add(conversation_id)
            entered.set()
            try:
                await asyncio.Event().wait()
            finally:
                active.remove(conversation_id)
                stopped.append(conversation_id)

        async def close() -> None:
            self.assertEqual(active, set())
            self.agent.closed = True

        with (
            patch.object(simulate.cards, 'deck', return_value=[card('bad', 'bad'), card('slow')]),
            patch.object(self.agent, 'say', side_effect=say),
            patch.object(self.agent, 'close', side_effect=close),
        ):
            result = await simulate.run('test')
        self.assertEqual(result['status'], 'failed')
        self.assertIn('unexpected agent failure', result['error'])
        self.assertEqual([item['status'] for item in result['items']], ['UNMEASURED', 'UNMEASURED'])
        self.assertTrue(result['finishedAt'])
        self.assertEqual(len(stopped), 1)
        self.assertTrue(self.agent.closed)

    async def test_cancelled_run_is_terminal_and_agent_is_closed(self) -> None:
        entered = asyncio.Event()

        async def evaluate(scenario: dict, item: dict) -> None:
            entered.set()
            await asyncio.Event().wait()

        with patch.object(simulate.judge, 'evaluate', side_effect=evaluate):
            task = asyncio.create_task(simulate.run('test'))
            await entered.wait()
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
        result = store.runs()[0]
        self.assertEqual(result['status'], 'stopped')
        self.assertEqual(result['items'][0]['status'], 'UNMEASURED')
        self.assertEqual(result['items'][0]['stage'], '')
        self.assertTrue(result['finishedAt'])
        self.assertTrue(self.agent.closed)

    async def test_unexpected_open_failure_is_terminal(self) -> None:
        with patch.object(self.agent, 'open', new=AsyncMock(side_effect=RuntimeError('cannot launch'))):
            result = await simulate.run('test')
        self.assertEqual(result['status'], 'failed')
        self.assertEqual(result['error'], 'cannot launch')
        self.assertTrue(result['finishedAt'])
        self.assertTrue(self.agent.closed)

    async def test_close_failure_is_a_finished_failed_run(self) -> None:
        async def evaluate(scenario: dict, item: dict) -> None:
            item.update(status='PASS')

        with (
            patch.object(simulate.judge, 'evaluate', side_effect=evaluate),
            patch.object(self.agent, 'close', new=AsyncMock(side_effect=RuntimeError('cannot close process'))),
        ):
            result = await simulate.run('test')
        self.assertEqual(result['status'], 'failed')
        self.assertEqual(result['error'], 'cannot close process')
        self.assertEqual(result['items'][0]['status'], 'PASS')
        self.assertTrue(result['finishedAt'])

    async def test_stop_during_close_waits_for_cleanup_and_persists_terminal_run(self) -> None:
        entered, release = asyncio.Event(), asyncio.Event()
        close_cancelled = []

        async def close() -> None:
            entered.set()
            try:
                await release.wait()
                self.agent.closed = True
            except asyncio.CancelledError:
                close_cancelled.append(True)
                raise

        async def evaluate(scenario: dict, item: dict) -> None:
            item.update(status='PASS')

        jobs = Jobs()
        with (
            patch.object(self.agent, 'close', side_effect=close),
            patch.object(simulate.judge, 'evaluate', side_effect=evaluate),
        ):
            jobs.start('run', lambda progress: simulate.run('test', progress=progress))
            await entered.wait()
            stopping = asyncio.create_task(jobs.stop())
            await asyncio.sleep(0)
            await asyncio.sleep(0)
            self.assertTrue(jobs.state['running'])
            self.assertFalse(self.agent.closed)
            release.set()
            await stopping
        result = store.runs()[0]
        self.assertFalse(jobs.state['running'])
        self.assertEqual(result['status'], 'stopped')
        self.assertTrue(result['finishedAt'])
        self.assertTrue(self.agent.closed)
        self.assertEqual(close_cancelled, [])

    async def test_repeated_stop_joins_agent_cleanup_before_releasing_job(self) -> None:
        entered, release = asyncio.Event(), asyncio.Event()

        async def close() -> None:
            entered.set()
            await release.wait()
            self.agent.closed = True

        async def evaluate(scenario: dict, item: dict) -> None:
            item.update(status='PASS')

        jobs = Jobs()
        with (
            patch.object(self.agent, 'close', side_effect=close),
            patch.object(simulate.judge, 'evaluate', side_effect=evaluate),
        ):
            jobs.start('run', lambda progress: simulate.run('test', progress=progress))
            await entered.wait()
            stopping = [asyncio.create_task(jobs.stop()), asyncio.create_task(jobs.stop())]
            await asyncio.sleep(0)
            self.assertTrue(jobs.state['running'])
            self.assertTrue(all(not stop.done() for stop in stopping))
            release.set()
            await asyncio.gather(*stopping)
        self.assertFalse(jobs.state['running'])
        self.assertTrue(self.agent.closed)
        result = store.runs()[0]
        self.assertEqual(result['status'], 'stopped')
        self.assertTrue(result['finishedAt'])

    async def test_rejudge_retries_previous_model_failure_and_clears_error(self) -> None:
        source = simulate.new_run('test', {'name': 'Test'}, '', 1, ['default'])
        item = simulate.new_item(card(), 'default', 1)
        item.update(
            status='UNMEASURED',
            conversation=[{'role': 'agent', 'text': 'answer'}],
            error='previous model failure',
            review='disagree',
        )
        source.update(items=[item], status='done')
        store.create_run(source)

        async def evaluate(scenario: dict, item: dict) -> None:
            item.update(status='PASS', rules=[{'status': 'PASS'}])

        with patch.object(simulate.judge, 'evaluate', side_effect=evaluate) as judge:
            result = await simulate.rejudge(store.run(source['id']))
        judge.assert_awaited_once()
        self.assertEqual(result['items'][0]['status'], 'PASS')
        self.assertIsNone(result['items'][0]['error'])
        self.assertIsNone(result['items'][0]['review'])

    async def test_failed_rejudge_does_not_show_old_successful_rules(self) -> None:
        source = simulate.new_run('test', {'name': 'Test'}, '', 1, ['default'])
        item = simulate.new_item(card(), 'default', 1)
        item.update(status='PASS', conversation=[{'role': 'agent', 'text': 'answer'}], rules=[{'status': 'PASS'}])
        source.update(items=[item], status='done')
        store.create_run(source)
        with patch.object(simulate.judge, 'evaluate', side_effect=simulate.llm.ModelError('model unavailable')):
            result = await simulate.rejudge(store.run(source['id']))
        self.assertEqual(result['items'][0]['status'], 'UNMEASURED')
        self.assertEqual(result['items'][0]['rules'], [])
        self.assertIsNone(result['metric']['accuracy'])

    async def test_rejudge_keeps_frozen_criteria_after_inputs_replace_and_deck_changes(self) -> None:
        frozen = card()
        frozen['criteria'] = [{'id': 'original', 'text': 'Original rule'}]
        source = simulate.new_run('test', {'name': 'Test'}, '', 1, ['default'])
        item = simulate.new_item(frozen, 'default', 1)
        frozen['criteria'][0]['text'] = 'Edited later'
        item.update(status='FAIL', conversation=[{'role': 'agent', 'text': 'answer'}], review='agree')
        source.update(items=[item], status='done')
        store.create_run(source)
        store.replace_inputs('logs.json', [])
        observed = []

        async def evaluate(scenario: dict, item: dict) -> None:
            observed.extend(scenario['criteria'])
            item.update(status='PASS', rules=[{'status': 'PASS'}])

        with (
            patch.object(simulate.cards, 'deck', return_value=[]),
            patch.object(simulate.judge, 'evaluate', side_effect=evaluate),
        ):
            result = await simulate.rejudge(store.run(source['id']))
        self.assertEqual(observed, [{'id': 'original', 'text': 'Original rule'}])
        self.assertEqual(result['items'][0]['status'], 'PASS')
        self.assertIsNone(result['items'][0]['review'])
        self.assertTrue(result['rejudgedAt'])

    async def test_legacy_rejudge_uses_matching_original_card_and_saves_criteria(self) -> None:
        source = simulate.new_run('test', {'name': 'Test'}, '', 1, ['default'])
        item = simulate.new_item(card(), 'default', 1)
        del item['criteria']
        item.update(status='FAIL', conversation=[{'role': 'agent', 'text': 'answer'}])
        source.update(items=[item], status='done')
        store.create_run(source)
        original = card()
        original['criteria'] = [{'id': 'old', 'text': 'Old rule'}]

        async def evaluate(scenario: dict, item: dict) -> None:
            self.assertEqual(scenario['criteria'], original['criteria'])
            item.update(status='PASS')

        with (
            patch.object(simulate.cards, 'deck', return_value=[original]),
            patch.object(simulate.judge, 'evaluate', side_effect=evaluate),
        ):
            result = await simulate.rejudge(store.run(source['id']))
        self.assertEqual(result['items'][0]['criteria'], original['criteria'])

    async def test_legacy_rejudge_without_original_criteria_fails_without_false_completion(self) -> None:
        source = simulate.new_run('test', {'name': 'Test'}, '', 1, ['default'])
        item = simulate.new_item(card(), 'default', 1)
        del item['criteria']
        item.update(status='FAIL', conversation=[{'role': 'agent', 'text': 'answer'}])
        source.update(items=[item], status='done')
        store.create_run(source)
        with (
            patch.object(simulate.cards, 'deck', return_value=[]),
            patch.object(simulate.judge, 'evaluate') as judge,
            self.assertRaisesRegex(RuntimeError, 'не сохранены критерии'),
        ):
            await simulate.rejudge(store.run(source['id']))
        judge.assert_not_awaited()
        self.assertNotIn('rejudgedAt', store.run(source['id']))

    async def test_rejudge_without_agent_answers_fails_without_false_completion(self) -> None:
        source = simulate.new_run('test', {'name': 'Test'}, '', 1, ['default'])
        source.update(items=[simulate.new_item(card(), 'default', 1)], status='stopped')
        store.create_run(source)
        with self.assertRaisesRegex(RuntimeError, 'нет записанных ответов'):
            await simulate.rejudge(store.run(source['id']))
        self.assertNotIn('rejudgedAt', store.run(source['id']))

    async def test_customer_messages_and_cached_openings_consume_labelled_model_answers(self) -> None:
        scenario = card()
        store.save(simulate.cards.DECK, {'cards': [scenario]})
        with patch.object(
            simulate.llm,
            'chat',
            side_effect=[
                simulate.llm.Answer(' "next question" ', 'actual-customer'),
                simulate.llm.Answer(' "rewritten opening" ', 'actual-customer'),
            ],
        ) as chat:
            message = await simulate.customer_says(scenario, [{'role': 'agent', 'text': 'answer'}])
            await simulate.prepare_openings([scenario], ['impatient'], lambda **values: None)
            cached = store.load(simulate.cards.DECK)['cards']
            await simulate.prepare_openings(cached, ['impatient'], lambda **values: None)
        self.assertEqual(message, 'next question')
        self.assertEqual(cached[0]['openings']['impatient'], 'rewritten opening')
        self.assertEqual(chat.await_count, 2)

    def test_agreement_of_the_two_checks_in_a_run_counts_only_conversations_both_decided(self) -> None:
        items = [
            {'cardId': 'a', 'status': 'FAIL', 'second': {'model': 'm', 'status': 'FAIL'}},
            {'cardId': 'b', 'status': 'FAIL', 'second': {'model': 'm', 'status': 'UNMEASURED'}},
            {'cardId': 'c', 'status': 'UNMEASURED', 'second': {'model': 'm', 'status': 'UNMEASURED'}},
            {'cardId': 'd', 'status': 'UNMEASURED', 'second': {'model': 'm', 'status': 'PASS'}},
        ]
        self.assertEqual(metric(items)['secondJudge'], {'model': 'm', 'checked': 1, 'agree': 1})


if __name__ == '__main__':
    unittest.main()
