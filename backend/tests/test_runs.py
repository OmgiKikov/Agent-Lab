import asyncio
import unittest
from unittest.mock import AsyncMock, patch

import support

from lab import storage
from lab.domain.metric import metric
from lab.flows import answers, inputs, simulation
from lab.jobs import Jobs


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

    def client(self, conversation_id: str) -> tuple[str | None, dict | None]:
        return None, None

    async def say(self, conversation_id: str, message: str, world: dict) -> dict:
        return {'text': 'answer', 'status': '202', 'ok': False, 'options': [], 'events': []}


class RunsTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        support.lab(self)
        self.agent = FakeAgent()
        patches = [
            patch.object(simulation.scenarios, 'deck', return_value=[card()]),
            patch.object(simulation.connection, 'ways', return_value={'test': {'name': 'Test'}}),
            patch.object(simulation.connection, 'connect', return_value=self.agent),
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
            patch.object(simulation.scenarios, 'deck', return_value=[card(), card('card-2')]),
            patch.object(simulation, 'evaluate', side_effect=evaluate),
        ):
            task = asyncio.create_task(simulation.run('test'))
            await entered.wait()
            run_id = storage.runs.listed()[0]['id']
            answers.on_run(run_id, 0, 'disagree')
            release.set()
            result = await task
        self.assertEqual(result['status'], 'done')
        self.assertTrue(result['finishedAt'])
        self.assertTrue(self.agent.closed)
        self.assertEqual(result['items'][0]['review'], 'disagree')
        self.assertEqual(result['metric']['human']['agree'], 0)
        self.assertIn('actual-judge-card-1', result['model'])
        self.assertIn('actual-judge-card-2', result['model'])

    async def test_a_conversation_is_written_once_when_it_ends_and_its_progress_stays_in_memory(self) -> None:
        entered, release = asyncio.Event(), asyncio.Event()

        async def say(conversation_id: str, message: str, world: dict) -> dict:
            return {'text': 'answer', 'status': '200', 'ok': True, 'options': [], 'events': []}

        async def customer(scenario: dict, conversation: list[dict], details: str = '', persona: str | None = None):
            return 'again'

        async def evaluate(scenario: dict, item: dict) -> None:
            if scenario['id'] == 'card-2':
                entered.set()
                await release.wait()
            item.update(status='PASS', rules=[{'ruleId': 'r', 'status': 'PASS'}])

        reported = []
        with (
            patch.object(simulation.scenarios, 'deck', return_value=[card(), card('card-2')]),
            patch.object(self.agent, 'say', side_effect=say),
            patch.object(simulation, 'customer_says', side_effect=customer),
            patch.object(simulation, 'evaluate', side_effect=evaluate),
            patch.object(storage.runs, '_save', wraps=storage.runs._save) as writes,
        ):
            task = asyncio.create_task(simulation.run('test', progress=lambda **values: reported.append(values)))
            await entered.wait()
            live = storage.runs.listed()[0]
            release.set()
            result = await task
        # The live view reads the record: a finished conversation is there while another one still plays.
        self.assertEqual([item['status'] for item in live['items']], ['PASS', 'RUNNING'])
        self.assertEqual(len(live['items'][0]['conversation']), 2 * simulation.MAX_AGENT_TURNS)
        self.assertEqual(live['metric']['total'], 1)
        # The agent's version, each conversation once when it ends, the finished run: never once per turn.
        self.assertEqual(writes.call_count, 1 + len(result['items']) + 1)
        self.assertGreater(len(reported), 2 * len(result['items']))
        self.assertEqual(reported[-1]['done'], 2)
        self.assertEqual([item['status'] for item in result['items']], ['PASS', 'PASS'])

    async def test_rejudge_patches_a_current_record_instead_of_stale_snapshot(self) -> None:
        source = simulation.new_run('test', {'name': 'Test'}, '', 1, ['default'])
        item = simulation.new_item(card(), 'default', 1)
        item.update(status='FAIL', conversation=[{'role': 'agent', 'text': 'answer'}], review=None)
        source.update(items=[item], status='done')
        stale = storage.runs.create(source)
        entered, release = asyncio.Event(), asyncio.Event()

        async def evaluate(scenario: dict, item: dict) -> None:
            entered.set()
            await release.wait()
            item.update(status='FAIL')

        with patch.object(simulation, 'evaluate', side_effect=evaluate):
            task = asyncio.create_task(simulation.rejudge(stale))
            await entered.wait()
            answers.on_run(source['id'], 0, 'disagree')
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
            patch.object(simulation.scenarios, 'deck', return_value=[card('bad', 'bad'), card('slow')]),
            patch.object(self.agent, 'say', side_effect=say),
            patch.object(self.agent, 'close', side_effect=close),
        ):
            result = await simulation.run('test')
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

        with patch.object(simulation, 'evaluate', side_effect=evaluate):
            task = asyncio.create_task(simulation.run('test'))
            await entered.wait()
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
        result = storage.runs.listed()[0]
        self.assertEqual(result['status'], 'stopped')
        self.assertEqual(result['items'][0]['status'], 'UNMEASURED')
        self.assertEqual(result['items'][0]['stage'], '')
        self.assertTrue(result['finishedAt'])
        self.assertTrue(self.agent.closed)

    async def test_a_stop_writes_what_it_cut_short_and_the_final_status_at_once(self) -> None:
        playing = asyncio.Event()

        async def say(conversation_id: str, message: str, world: dict) -> dict:
            playing.set()
            await asyncio.Event().wait()  # every conversation waits for the agent; the rest are queued

        scenarios = [card(f'card-{number}') for number in range(2 * simulation.PARALLEL)]
        with (
            patch.object(simulation.scenarios, 'deck', return_value=scenarios),
            patch.object(self.agent, 'say', side_effect=say),
        ):
            task = asyncio.create_task(simulation.run('test'))
            await playing.wait()
            with patch.object(storage.runs, '_save', wraps=storage.runs._save) as writes:
                task.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await task
        self.assertEqual(writes.call_count, 1)
        result = storage.runs.listed()[0]
        self.assertEqual((result['status'], result['error']), ('stopped', 'Прогон остановлен'))
        self.assertTrue(result['finishedAt'])
        self.assertEqual(
            {(item['status'], item['error']) for item in result['items']}, {('UNMEASURED', 'Прогон остановлен')}
        )
        self.assertEqual(result['metric']['unmeasured'], len(scenarios))

    async def test_unexpected_open_failure_is_terminal(self) -> None:
        with patch.object(self.agent, 'open', new=AsyncMock(side_effect=RuntimeError('cannot launch'))):
            result = await simulation.run('test')
        self.assertEqual(result['status'], 'failed')
        self.assertEqual(result['error'], 'cannot launch')
        self.assertTrue(result['finishedAt'])
        self.assertTrue(self.agent.closed)

    async def test_a_run_in_which_the_agent_answered_nothing_fails_and_says_why(self) -> None:
        """Every conversation broke on the agent's first turn, so nothing can ever be judged. The run said «сыграно»
        and the reason surfaced only after «Оценить заново»; the run itself now fails with it. One answer is a played
        run."""

        async def unreachable(conversation_id: str, message: str, world: dict) -> dict:
            raise simulation.agents.AgentError('Нет связи с агентом (ConnectError).')

        async def once(conversation_id: str, message: str, world: dict) -> dict:
            if message == 'card-2':
                raise simulation.agents.AgentError('Нет связи с агентом (ConnectError).')
            return {'text': 'answer', 'status': '202', 'ok': False, 'options': [], 'events': []}

        async def passed(scenario: dict, item: dict) -> None:
            item.update(status='PASS', rules=[])

        for say, expected in (
            (unreachable, ('failed', 'Агент не ответил ни в одном разговоре. Нет связи с агентом (ConnectError).')),
            (once, ('done', None)),
        ):
            with (
                self.subTest(say=say.__name__),
                patch.object(simulation.scenarios, 'deck', return_value=[card(), card('card-2', 'card-2')]),
                patch.object(self.agent, 'say', side_effect=say),
                patch.object(simulation, 'evaluate', side_effect=passed),
            ):
                result = await simulation.run('test')
                self.assertEqual((result['status'], result['error']), expected)
                self.assertEqual(result['items'][1]['error'], 'Нет связи с агентом (ConnectError).')
                # The list of runs (/api/state) has the reason without reading the conversations.
                listed = next(summary for summary in storage.runs.summaries() if summary['id'] == result['id'])
                self.assertEqual((listed['status'], listed['error']), expected)

    async def test_close_failure_is_a_finished_failed_run(self) -> None:
        async def evaluate(scenario: dict, item: dict) -> None:
            item.update(status='PASS')

        with (
            patch.object(simulation, 'evaluate', side_effect=evaluate),
            patch.object(self.agent, 'close', new=AsyncMock(side_effect=RuntimeError('cannot close process'))),
        ):
            result = await simulation.run('test')
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
            patch.object(simulation, 'evaluate', side_effect=evaluate),
        ):
            jobs.start('run', lambda progress: simulation.run('test', progress=progress))
            await entered.wait()
            stopping = asyncio.create_task(jobs.stop())
            await asyncio.sleep(0)
            await asyncio.sleep(0)
            self.assertTrue(jobs.state['running'])
            self.assertFalse(self.agent.closed)
            release.set()
            await stopping
        result = storage.runs.listed()[0]
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
            patch.object(simulation, 'evaluate', side_effect=evaluate),
        ):
            jobs.start('run', lambda progress: simulation.run('test', progress=progress))
            await entered.wait()
            stopping = [asyncio.create_task(jobs.stop()), asyncio.create_task(jobs.stop())]
            await asyncio.sleep(0)
            self.assertTrue(jobs.state['running'])
            self.assertTrue(all(not stop.done() for stop in stopping))
            release.set()
            await asyncio.gather(*stopping)
        self.assertFalse(jobs.state['running'])
        self.assertTrue(self.agent.closed)
        result = storage.runs.listed()[0]
        self.assertEqual(result['status'], 'stopped')
        self.assertTrue(result['finishedAt'])

    async def test_rejudge_retries_previous_model_failure_and_clears_error(self) -> None:
        source = simulation.new_run('test', {'name': 'Test'}, '', 1, ['default'])
        item = simulation.new_item(card(), 'default', 1)
        item.update(
            status='UNMEASURED',
            conversation=[{'role': 'agent', 'text': 'answer'}],
            error='previous model failure',
            review='disagree',
        )
        source.update(items=[item], status='done')
        storage.runs.create(source)

        async def evaluate(scenario: dict, item: dict) -> None:
            item.update(status='PASS', rules=[{'status': 'PASS'}])

        with patch.object(simulation, 'evaluate', side_effect=evaluate) as judge:
            result = await simulation.rejudge(storage.runs.get(source['id']))
        judge.assert_awaited_once()
        self.assertEqual(result['items'][0]['status'], 'PASS')
        self.assertIsNone(result['items'][0]['error'])
        self.assertIsNone(result['items'][0]['review'])

    async def test_a_rejudge_the_model_did_not_answer_leaves_the_verdicts_and_the_answers(self) -> None:
        """An outage is not a verdict: «Оценить заново» while the model is down fails, and the run keeps its verdicts
        and the answers people gave on them."""
        source = simulation.new_run('test', {'name': 'Test'}, '', 1, ['default'])
        item = simulation.new_item(card(), 'default', 1)
        row = {'ruleId': 'r1', 'status': 'FAIL', 'reason': 'нет срока', 'agentQuote': 'answer'}
        item.update(status='FAIL', conversation=[{'role': 'agent', 'text': 'answer'}], rules=[row], ended=True)
        source.update(items=[item], status='done')
        storage.runs.create(source)
        answers.on_run(source['id'], 0, 'agree', 'r1', 'FAIL')
        before = storage.runs.get(source['id'])
        down = simulation.models.ModelError('Модель недоступна (ConnectError).')
        with (
            patch.object(simulation, 'evaluate', side_effect=down),
            self.assertRaises(simulation.models.ModelError) as caught,
        ):
            await simulation.rejudge(storage.runs.get(source['id']))
        self.assertIn('1\u00a0из\u00a01', str(caught.exception))
        self.assertIn('Прогон остался прежним', str(caught.exception))
        self.assertIn('Модель недоступна (ConnectError).', str(caught.exception))
        self.assertEqual(storage.runs.get(source['id']), before)
        self.assertEqual(storage.runs.get(source['id'])['items'][0]['rules'][0]['review'], 'agree')

    async def test_a_rejudge_with_one_conversation_unanswered_writes_none_of_the_new_verdicts(self) -> None:
        source = simulation.new_run('test', {'name': 'Test'}, '', 1, ['default'])
        items = []
        for index in range(2):
            item = simulation.new_item(card(f'card-{index}'), 'default', 1)
            item.update(status='PASS', conversation=[{'role': 'agent', 'text': 'answer'}], rules=[], ended=True)
            items.append(item)
        source.update(items=items, status='done')
        storage.runs.create(source)
        before = storage.runs.get(source['id'])

        async def evaluate(scenario: dict, item: dict) -> None:
            if scenario['cardId'] == 'card-1':
                raise simulation.models.ModelError('Не удалось разобрать ответ модели.')
            item.update(status='FAIL', rules=[{'ruleId': 'r1', 'status': 'FAIL'}])

        with (
            patch.object(simulation, 'evaluate', side_effect=evaluate),
            self.assertRaises(simulation.models.ModelError) as caught,
        ):
            await simulation.rejudge(storage.runs.get(source['id']))
        self.assertIn('1\u00a0из\u00a02', str(caught.exception))
        self.assertEqual(storage.runs.get(source['id']), before)

    async def test_rejudge_keeps_frozen_criteria_after_inputs_replace_and_deck_changes(self) -> None:
        frozen = card()
        frozen['criteria'] = [{'id': 'original', 'text': 'Original rule'}]
        source = simulation.new_run('test', {'name': 'Test'}, '', 1, ['default'])
        item = simulation.new_item(frozen, 'default', 1)
        frozen['criteria'][0]['text'] = 'Edited later'
        item.update(status='FAIL', conversation=[{'role': 'agent', 'text': 'answer'}], review='agree')
        source.update(items=[item], status='done')
        storage.runs.create(source)
        inputs.replace_export([])
        observed = []

        async def evaluate(scenario: dict, item: dict) -> None:
            observed.extend(scenario['criteria'])
            item.update(status='PASS', rules=[{'status': 'PASS'}])

        with (
            patch.object(simulation.scenarios, 'deck', return_value=[]),
            patch.object(simulation, 'evaluate', side_effect=evaluate),
        ):
            result = await simulation.rejudge(storage.runs.get(source['id']))
        self.assertEqual(observed, [{'id': 'original', 'text': 'Original rule'}])
        self.assertEqual(result['items'][0]['status'], 'PASS')
        self.assertIsNone(result['items'][0]['review'])
        self.assertTrue(result['rejudgedAt'])

    async def test_legacy_rejudge_uses_matching_original_card_and_saves_criteria(self) -> None:
        source = simulation.new_run('test', {'name': 'Test'}, '', 1, ['default'])
        item = simulation.new_item(card(), 'default', 1)
        del item['criteria']
        item.update(status='FAIL', conversation=[{'role': 'agent', 'text': 'answer'}])
        source.update(items=[item], status='done')
        storage.runs.create(source)
        original = card()
        original['criteria'] = [{'id': 'old', 'text': 'Old rule'}]

        async def evaluate(scenario: dict, item: dict) -> None:
            self.assertEqual(scenario['criteria'], original['criteria'])
            item.update(status='PASS')

        with (
            patch.object(simulation.scenarios, 'deck', return_value=[original]),
            patch.object(simulation, 'evaluate', side_effect=evaluate),
        ):
            result = await simulation.rejudge(storage.runs.get(source['id']))
        self.assertEqual(result['items'][0]['criteria'], original['criteria'])

    async def test_legacy_rejudge_without_original_criteria_fails_without_false_completion(self) -> None:
        source = simulation.new_run('test', {'name': 'Test'}, '', 1, ['default'])
        item = simulation.new_item(card(), 'default', 1)
        del item['criteria']
        item.update(status='FAIL', conversation=[{'role': 'agent', 'text': 'answer'}])
        source.update(items=[item], status='done')
        storage.runs.create(source)
        with (
            patch.object(simulation.scenarios, 'deck', return_value=[]),
            patch.object(simulation, 'evaluate') as judge,
            self.assertRaisesRegex(RuntimeError, 'не сохранены критерии'),
        ):
            await simulation.rejudge(storage.runs.get(source['id']))
        judge.assert_not_awaited()
        self.assertNotIn('rejudgedAt', storage.runs.get(source['id']))

    async def test_rejudge_without_agent_answers_fails_without_false_completion(self) -> None:
        source = simulation.new_run('test', {'name': 'Test'}, '', 1, ['default'])
        source.update(items=[simulation.new_item(card(), 'default', 1)], status='stopped')
        storage.runs.create(source)
        with self.assertRaisesRegex(RuntimeError, 'нет записанных ответов'):
            await simulation.rejudge(storage.runs.get(source['id']))
        self.assertNotIn('rejudgedAt', storage.runs.get(source['id']))

    def played(self, count: int = 3) -> str:
        """A finished run whose conversations all passed under an older model."""
        source = simulation.new_run('test', {'name': 'Test'}, '', 1, ['default'])
        items = [simulation.new_item(card(f'card-{n}'), 'default', 1) for n in range(count)]
        for item in items:
            item.update(
                status='PASS',
                ended=True,
                model='old-model',
                conversation=[{'role': 'agent', 'text': 'answer'}],
                rules=[{'ruleId': 'r', 'status': 'PASS'}],
            )
        source.update(items=items, status='done', model='old-model')
        storage.runs.create(source)
        return source['id']

    async def test_stopped_rejudge_leaves_the_run_as_it_was(self) -> None:
        run_id = self.played()
        first = asyncio.Event()

        async def evaluate(scenario: dict, item: dict) -> None:
            if item['cardId'] != 'card-0':
                await asyncio.Event().wait()  # the other conversations are still being judged
            item.update(status='FAIL', model='new-model', rules=[{'ruleId': 'r', 'status': 'FAIL'}])
            first.set()

        jobs = Jobs()
        with patch.object(simulation, 'evaluate', side_effect=evaluate):
            jobs.start('rejudge', lambda progress: simulation.rejudge(storage.runs.get(run_id), progress))
            await first.wait()
            await asyncio.sleep(0)
            await jobs.stop()
        result = storage.runs.get(run_id)
        self.assertEqual([(item['status'], item['model']) for item in result['items']], [('PASS', 'old-model')] * 3)
        self.assertEqual((result['status'], result['model'], result['metric']['failed']), ('done', 'old-model', 0))
        self.assertNotIn('rejudgedAt', result)
        self.assertEqual(jobs.state['error'], 'Остановлено')

    async def test_rejudge_applies_all_new_verdicts_at_once_or_none_when_it_fails(self) -> None:
        run_id = self.played()

        async def crashes(scenario: dict, item: dict) -> None:
            if item['cardId'] == 'card-1':
                raise RuntimeError('judge crashed')
            item.update(status='FAIL', model='new-model', rules=[{'ruleId': 'r', 'status': 'FAIL'}])

        with (
            patch.object(simulation, 'evaluate', side_effect=crashes),
            self.assertRaisesRegex(ExceptionGroup, 'unhandled errors'),
        ):
            await simulation.rejudge(storage.runs.get(run_id))
        self.assertEqual([item['status'] for item in storage.runs.get(run_id)['items']], ['PASS'] * 3)

        async def fails(scenario: dict, item: dict) -> None:
            item.update(status='FAIL', model='new-model', rules=[{'ruleId': 'r', 'status': 'FAIL'}])

        with (
            patch.object(simulation, 'evaluate', side_effect=fails),
            patch.object(storage.runs, '_save', wraps=storage.runs._save) as writes,
        ):
            result = await simulation.rejudge(storage.runs.get(run_id))
        self.assertEqual(writes.call_count, 1)
        self.assertEqual([item['status'] for item in result['items']], ['FAIL'] * 3)
        self.assertEqual((result['model'], result['metric']['failed']), ('new-model', 3))
        self.assertTrue(result['rejudgedAt'])

    async def test_rejudge_keeps_conversations_the_agent_or_the_customer_model_cut_short(self) -> None:
        async def say(conversation_id: str, message: str, world: dict) -> dict:
            if message == 'agent-broke again':
                raise simulation.agents.AgentError('Агент ответил HTTP 500')
            return {'text': 'answer', 'status': '200', 'ok': True, 'options': [], 'events': []}

        async def customer(scenario: dict, conversation: list[dict], details: str = '', persona: str | None = None):
            if scenario['id'] == 'customer-broke':
                raise simulation.models.ModelError('Модель недоступна')
            return f'{scenario["id"]} again'

        async def passed(scenario: dict, item: dict) -> None:
            item.update(status='PASS', rules=[{'ruleId': 'r', 'status': 'PASS'}])

        async def failed(scenario: dict, item: dict) -> None:
            item.update(status='FAIL', rules=[{'ruleId': 'r', 'status': 'FAIL'}])

        scenarios = [card('whole'), card('agent-broke'), card('customer-broke')]
        with (
            patch.object(simulation.scenarios, 'deck', return_value=scenarios),
            patch.object(self.agent, 'say', side_effect=say),
            patch.object(simulation, 'customer_says', side_effect=customer),
            patch.object(simulation, 'evaluate', side_effect=passed),
        ):
            played = await simulation.run('test')
        with patch.object(simulation, 'evaluate', side_effect=failed):
            result = await simulation.rejudge(played)
        whole, agent_broke, customer_broke = result['items']
        self.assertEqual(whole['status'], 'FAIL')
        self.assertEqual((agent_broke['status'], agent_broke['error']), ('UNMEASURED', 'Агент ответил HTTP 500'))
        self.assertEqual((customer_broke['status'], customer_broke['error']), ('UNMEASURED', 'Модель недоступна'))
        self.assertEqual(agent_broke['rules'], [])
        self.assertEqual(result['metric']['measured'], 1)

    async def test_rejudge_keeps_conversations_a_stop_cut_short(self) -> None:
        answered = asyncio.Event()

        async def say(conversation_id: str, message: str, world: dict) -> dict:
            return {'text': 'answer', 'status': '200', 'ok': True, 'options': [], 'events': []}

        async def customer(scenario: dict, conversation: list[dict], details: str = '', persona: str | None = None):
            answered.set()
            await asyncio.Event().wait()  # the customer's model is still writing when the run is stopped

        with (
            patch.object(self.agent, 'say', side_effect=say),
            patch.object(simulation, 'customer_says', side_effect=customer),
        ):
            task = asyncio.create_task(simulation.run('test'))
            await answered.wait()
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
        stopped = storage.runs.listed()[0]
        with (
            patch.object(simulation, 'evaluate') as judge,
            self.assertRaisesRegex(RuntimeError, 'нет записанных ответов'),
        ):
            await simulation.rejudge(stopped)
        judge.assert_not_awaited()
        item = storage.runs.get(stopped['id'])['items'][0]
        self.assertEqual((item['status'], item['error']), ('UNMEASURED', 'Прогон остановлен'))

    async def test_rejudge_of_an_older_record_keeps_a_conversation_that_ended_on_the_customer(self) -> None:
        source = simulation.new_run('test', {'name': 'Test'}, '', 1, ['default'])
        whole, broken = (
            simulation.new_item(card('whole'), 'default', 1),
            simulation.new_item(card('broken'), 'default', 1),
        )
        whole.update(status='PASS', conversation=[{'role': 'customer', 'text': 'q'}, {'role': 'agent', 'text': 'a'}])
        broken.update(
            status='UNMEASURED',
            error='Агент ответил HTTP 500',
            conversation=[
                {'role': 'customer', 'text': 'q'},
                {'role': 'agent', 'text': 'Уточните номер терминала'},
                {'role': 'customer', 'text': '12345678'},
            ],
        )
        source.update(items=[whole, broken], status='done')
        storage.runs.create(source)

        async def failed(scenario: dict, item: dict) -> None:
            item.update(status='FAIL', rules=[{'ruleId': 'r', 'status': 'FAIL'}])

        with patch.object(simulation, 'evaluate', side_effect=failed):
            result = await simulation.rejudge(storage.runs.get(source['id']))
        self.assertEqual(result['items'][0]['status'], 'FAIL')
        self.assertEqual(
            (result['items'][1]['status'], result['items'][1]['error']), ('UNMEASURED', 'Агент ответил HTTP 500')
        )

    async def test_a_run_remembers_the_check_its_deck_was_built_from(self) -> None:
        storage.documents.save(simulation.scenarios.DECK, {'check': 'tone', 'cards': [card()]})

        async def evaluate(scenario: dict, item: dict) -> None:
            item.update(status='PASS', rules=[])

        with patch.object(simulation, 'evaluate', side_effect=evaluate):
            result = await simulation.run('test')
        self.assertEqual(result['check'], 'tone')
        self.assertEqual(storage.runs.summaries()[0]['check'], 'tone')

    def test_a_run_from_before_runs_remembered_their_check_has_the_check_of_its_criteria(self) -> None:
        def played(run_id: str, criterion: dict, topic: str = 'Терминалы') -> None:
            item = simulation.new_item(dict(card(), topic=topic, criteria=[criterion]), 'default', 1)
            storage.runs.create({'id': run_id, 'startedAt': run_id, 'status': 'done', 'items': [item]})

        played('1', {'id': 'pronouns', 'text': 'На вы', 'sourceId': 'tone-of-voice'})
        played('2', {'id': 'pronouns', 'text': 'На вы'}, topic='Tone of voice')  # a card kept no source of its criteria
        played('3', {'id': 't1r1', 'text': 'Называет срок', 'sourceId': 's1'})
        summaries = storage.runs.summaries()
        self.assertEqual(
            [(summary['id'], summary['check']) for summary in summaries], [('3', 'code'), ('2', 'tone'), ('1', 'tone')]
        )
        self.assertEqual(storage.runs.get('2')['check'], 'tone')

    async def test_customer_messages_and_cached_openings_consume_labelled_model_answers(self) -> None:
        scenario = card()
        storage.documents.save(simulation.scenarios.DECK, {'cards': [scenario]})
        with patch.object(
            simulation.models,
            'chat',
            side_effect=[
                simulation.models.Reply(' "next question" ', 'actual-customer'),
                simulation.models.Reply(' "rewritten opening" ', 'actual-customer'),
            ],
        ) as chat:
            message = await simulation.customer_says(scenario, [{'role': 'agent', 'text': 'answer'}])
            await simulation.prepare_openings([scenario], ['impatient'], lambda **values: None)
            cached = storage.documents.load(simulation.scenarios.DECK)['cards']
            await simulation.prepare_openings(cached, ['impatient'], lambda **values: None)
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
