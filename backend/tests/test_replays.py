"""The live agent on the same customers: the conversations of a check's result played again with the agent under test
(domain.replay, flows.replay, storage.replays) and compared with the recordings, pair by pair."""

import unittest
from unittest.mock import AsyncMock, patch

import support

from lab import storage
from lab.domain import replay, statistics
from lab.flows import conversations, inputs
from lab.flows import replay as live


def recorded(dialogue_id: str, *turns: tuple[str, str]) -> dict:
    """A conversation of an export: (role, text) turns, role 'user' or 'assistant'."""
    return {'id': dialogue_id, 'messages': [{'role': role, 'content': text} for role, text in turns]}


def verdict(dialogue_id: str, status: str, *rows: tuple[str, str]) -> dict:
    """A conversation's verdict in a check's result: (ruleId, status) rows."""
    return {
        'dialogueId': dialogue_id,
        'topicId': 't1',
        'status': status,
        'rules': [{'ruleId': rule, 'status': row, 'agentQuote': 'Ответ', 'reason': 'Причина'} for rule, row in rows],
        'model': 'judge-a',
        'judgeVersion': 'v1',
        'second': None,
    }


TOPICS = [
    {
        'id': 't1',
        'title': 'Tone of voice',
        'rules': [
            {'id': 'pronouns', 'name': 'Обращение', 'text': 'Обращается на «вы»', 'quote': 'на «вы»'},
            {'id': 'simple', 'name': 'Простой язык', 'text': 'Пишет просто', 'quote': 'просто'},
        ],
    }
]


def item(before: str, now: str, before_rows=(), now_rows=(), model: str = 'judge-a') -> dict:
    """A played conversation: its verdict in the recordings and now."""
    return {
        'dialogueId': 'd',
        'topicId': 't1',
        'before': {
            'status': before,
            'rules': [{'ruleId': r, 'status': s} for r, s in before_rows],
            'model': 'judge-a',
            'judgeVersion': 'v1',
            'second': None,
        },
        'status': now,
        'rules': [{'ruleId': r, 'status': s} for r, s in now_rows],
        'model': model if now in ('PASS', 'FAIL') else None,
        'judgeVersion': 'v1' if now in ('PASS', 'FAIL') else None,
        'second': None,
    }


class CustomerTests(unittest.TestCase):
    def test_the_customer_begins_with_the_real_first_message_and_wants_the_same(self) -> None:
        dialogue = recorded(
            'd1',
            ('user', 'Сняли деньги  дважды'),
            ('assistant', 'Назовите номер терминала'),
            ('user', 'Терминал #####'),
            ('assistant', 'Вернём в течение дня'),
        )
        self.assertEqual(replay.opening(dialogue), 'Сняли деньги  дважды')
        self.assertEqual(replay.replies(dialogue), 2)
        situation = replay.situation(dialogue)
        self.assertIn('1. «Сняли деньги дважды»', situation)
        self.assertIn('2. «Терминал #####»', situation)
        self.assertIn('Добивайся того же', situation)
        self.assertNotIn('Вернём', situation)  # the customer's own words only

    def test_the_agent_answers_as_many_times_as_in_the_recording_from_one_to_three(self) -> None:
        one = recorded('d', ('user', 'Вопрос'))
        many = recorded('d', *[(role, 'x') for _ in range(5) for role in ('user', 'assistant')])
        self.assertEqual((replay.replies(one), replay.replies(many)), (1, replay.MAX_REPLIES))

    def test_a_played_conversation_is_judged_as_a_recorded_one(self) -> None:
        played = {
            'dialogueId': 'd1',
            'conversation': [
                {'role': 'customer', 'text': 'Вопрос'},
                {'role': 'agent', 'text': 'Ответ', 'options': ['Да', 'Нет']},
                {'role': 'customer', 'text': 'Да'},
                {'role': 'agent', 'text': 'Готово', 'options': []},
            ],
        }
        self.assertEqual(
            replay.as_dialogue(played),
            recorded(
                'd1',
                ('user', 'Вопрос'),
                ('assistant', 'Ответ\n[Кнопки: Да | Нет]'),
                ('user', 'Да'),
                ('assistant', 'Готово'),
            ),
        )

    def test_the_same_customers_are_the_judged_ones_of_the_result(self) -> None:
        result = {
            'results': [
                verdict('a', 'FAIL'),
                verdict('b', 'UNMEASURED'),
                verdict('c', 'PASS'),
                verdict('d', 'FAIL'),
            ]
        }
        chosen = replay.chosen(result, 2)
        self.assertEqual(len(chosen), 2)
        self.assertTrue(set(chosen) <= {'a', 'c', 'd'})
        self.assertEqual(replay.chosen(result, 2), chosen)  # the same ones every time
        self.assertEqual(sorted(replay.chosen(result, 10)), ['a', 'c', 'd'])


class SummaryTests(unittest.TestCase):
    def test_pairs_say_what_changed_for_each_customer(self) -> None:
        record = {
            'topics': TOPICS,
            'items': [
                item('FAIL', 'PASS', [('pronouns', 'FAIL')], [('pronouns', 'PASS')]),
                item('FAIL', 'PASS', [('pronouns', 'FAIL')], [('pronouns', 'PASS')]),
                item('PASS', 'FAIL', [('simple', 'PASS')], [('simple', 'FAIL')]),
                item('FAIL', 'FAIL', [('pronouns', 'FAIL')], [('pronouns', 'FAIL')]),
                item('PASS', 'PASS', [('pronouns', 'PASS')], [('pronouns', 'PASS')]),
                item('FAIL', 'UNMEASURED'),
                item('PASS', 'RUNNING'),
            ],
        }
        summary = replay.summarize(record)
        self.assertEqual(
            {key: summary[key] for key in ('pairs', 'fixed', 'broken', 'failing', 'passing', 'unmeasured', 'running')},
            {'pairs': 5, 'fixed': 2, 'broken': 1, 'failing': 1, 'passing': 1, 'unmeasured': 1, 'running': 1},
        )
        self.assertEqual(
            (summary['before'], summary['now']), ({'failed': 3, 'measured': 5}, {'failed': 2, 'measured': 5})
        )
        self.assertEqual((summary['verdict'], summary['direction']), ('few', 'fewer'))
        self.assertTrue(summary['comparable'])
        by_name = {c['name']: c for c in summary['criteria']}
        self.assertEqual(by_name['Обращение']['before'], {'failed': 3, 'measured': 4})
        self.assertEqual(by_name['Обращение']['now'], {'failed': 1, 'measured': 4})
        self.assertEqual(by_name['Простой язык']['now'], {'failed': 1, 'measured': 1})
        self.assertEqual(replay.change(record['items'][0]), 'fixed')
        self.assertEqual(replay.change(record['items'][5]), 'unmeasured')

    def test_judged_by_other_models_the_numbers_stand_but_nothing_is_concluded(self) -> None:
        items = [item('FAIL', 'PASS', model='judge-b') for _ in range(40)]
        summary = replay.summarize({'topics': TOPICS, 'items': items})
        self.assertFalse(summary['comparable'])
        self.assertEqual((summary['verdict'], summary['direction']), (None, 'fewer'))
        self.assertEqual(summary['now'], {'failed': 0, 'measured': 40})

    def test_many_pairs_mostly_fixed_is_beyond_chance(self) -> None:
        items = [item('FAIL', 'PASS') for _ in range(20)] + [item('PASS', 'PASS') for _ in range(20)]
        self.assertEqual(replay.summarize({'topics': TOPICS, 'items': items})['verdict'], 'beyond-chance')


class PairedStatisticsTests(unittest.TestCase):
    def test_mcnemar_exact(self) -> None:
        self.assertEqual(statistics.mcnemar(0, 0), 1.0)
        self.assertAlmostEqual(statistics.mcnemar(10, 0), 2 / 2**10)
        self.assertAlmostEqual(statistics.mcnemar(3, 3), 1.0)
        self.assertLess(statistics.mcnemar(15, 2), 0.05)
        self.assertGreater(statistics.mcnemar(6, 3), 0.05)

    def test_paired_verdict(self) -> None:
        self.assertEqual(statistics.paired(5, 1, 10), ('few', 'fewer'))
        self.assertEqual(statistics.paired(15, 2, 60), ('beyond-chance', 'fewer'))
        self.assertEqual(statistics.paired(2, 15, 60), ('beyond-chance', 'more'))
        self.assertEqual(statistics.paired(6, 3, 60), ('within-chance', 'fewer'))
        self.assertEqual(statistics.paired(4, 4, 60), ('same', 'same'))
        self.assertEqual(statistics.paired(0, 0, 0), (None, None))


class FakeAgent:
    """The agent under test: answers every line, and remembers what it was told in each conversation."""

    version = '1.4.2'
    mocked = False

    def __init__(self) -> None:
        self.told: dict[str, list[str]] = {}

    async def open(self) -> None:
        pass

    async def close(self) -> None:
        pass

    async def say(self, conversation_id: str, message: str, world: dict) -> dict:
        self.told.setdefault(conversation_id, []).append(message)
        return {'text': f'Ответ на «{message}»', 'status': '200', 'ok': True, 'options': [], 'events': []}


def judged_as(status: str):
    """The judge of the recordings, replaced: every criterion of the topic gets this status, quoting the agent."""

    async def judge(dialogue: dict, topic: dict) -> dict:
        return {
            'dialogueId': dialogue['id'],
            'topicId': topic['id'],
            'status': status,
            'rules': [
                {'ruleId': rule['id'], 'status': status, 'agentQuote': 'Ответ', 'reason': 'r', 'rule': rule['text']}
                for rule in topic['rules']
            ],
            'second': None,
            'opening': dialogue['messages'][0]['content'],
            'error': None,
            'model': 'judge-a',
            'judgeVersion': 'v1',
        }

    return judge


class LiveFlowTests(unittest.IsolatedAsyncioTestCase):
    """A check of the live agent on the customers of tone of voice's result."""

    def setUp(self) -> None:
        support.lab(self)
        self.export = inputs.add_export(
            [
                recorded(
                    'd1', ('user', 'Сняли дважды'), ('assistant', 'Номер?'), ('user', '#####'), ('assistant', 'Ок')
                ),
                recorded('d2', ('user', 'Как подключить СБП'), ('assistant', 'Так')),
                recorded('d3', ('user', 'Привет'), ('assistant', 'Здравствуйте')),
            ],
            'Сентябрь.xlsx',
        )
        rules = [
            {
                'id': 'pronouns',
                'name': 'Обращение',
                'text': 'На «вы»',
                'quote': 'на «вы»',
                'clarifications': ['И с маленькой'],
            }
        ]
        self.result = {
            'purpose': 'tone-of-voice',
            'checkId': 'c1',
            'finishedAt': '2026-10-02T10:00:00+00:00',
            'export': storage.exports.line(self.export),
            'topics': [{'id': 't1', 'title': 'Tone of voice', 'rules': rules, 'dialogueIds': ['d1', 'd2', 'd3']}],
            'results': [
                verdict('d1', 'FAIL', ('pronouns', 'FAIL')),
                verdict('d2', 'PASS', ('pronouns', 'PASS')),
                verdict('d3', 'UNMEASURED'),
            ],
        }
        storage.documents.save('tone-result.json', self.result)
        self.agent = FakeAgent()
        for mocked in (
            patch.object(live.connection, 'ways', return_value={'test': {'name': 'Тестовый стенд', 'customer': ''}}),
            patch.object(live.connection, 'connect', return_value=self.agent),
            patch.object(
                live.customer, 'reply', AsyncMock(return_value=live.customer.Answer('Терминал 12345678', 'm'))
            ),
        ):
            mocked.start()
            self.addCleanup(mocked.stop)

    async def test_the_same_customers_meet_the_agent_and_the_same_judge_judges_it(self) -> None:
        judge = AsyncMock(side_effect=judged_as('PASS'))
        with patch.object(conversations, 'judge_dialogue', judge):
            record = await live.run('tone', 'test', 10)
        self.assertEqual(record['status'], 'done')
        self.assertEqual((record['version'], record['targetName']), ('1.4.2', 'Тестовый стенд'))
        self.assertEqual(record['basis']['checkId'], 'c1')
        self.assertEqual(sorted(item['dialogueId'] for item in record['items']), ['d1', 'd2'])
        by_id = {item['dialogueId']: item for item in record['items']}
        # The real first message, word for word; the agent answers as many times as it did in the recording.
        told = {conversation[0]: conversation for conversation in self.agent.told.values()}
        self.assertEqual(told['Сняли дважды'], ['Сняли дважды', 'Терминал 12345678'])
        self.assertEqual(told['Как подключить СБП'], ['Как подключить СБП'])
        self.assertEqual(len(by_id['d1']['conversation']), 4)
        # The judge of the recordings, with the criteria of the result as the check judged them (clarified).
        topic = judge.await_args_list[0].args[1]
        self.assertIn('Уточнения, подтверждённые человеком', topic['rules'][0]['text'])
        self.assertEqual(judge.await_count, 2)
        self.assertEqual(record['summary']['fixed'], 1)
        self.assertEqual(record['summary']['before'], {'failed': 1, 'measured': 2})
        self.assertEqual(record['summary']['now'], {'failed': 0, 'measured': 2})
        self.assertEqual(storage.replays.summaries()[0]['summary']['fixed'], 1)

    async def test_without_a_result_there_is_nobody_to_meet(self) -> None:
        storage.documents.save('tone-result.json', None)
        with self.assertRaisesRegex(ValueError, 'ещё нет итога'):
            live.ready('tone')

    async def test_an_agent_that_never_answers_fails_the_check_saying_why(self) -> None:
        async def down(conversation_id: str, message: str, world: dict) -> dict:
            raise live.agents.AgentError('Нет связи с агентом (ConnectError).')

        with patch.object(self.agent, 'say', side_effect=down):
            record = await live.run('tone', 'test', 10)
        self.assertEqual(record['status'], 'failed')
        self.assertIn('Нет связи с агентом', record['error'])
        self.assertEqual({item['status'] for item in record['items']}, {'UNMEASURED'})

    async def test_a_restart_judges_what_ended_and_plays_the_rest_again(self) -> None:
        judge = AsyncMock(side_effect=judged_as('FAIL'))
        with patch.object(conversations, 'judge_dialogue', judge):
            first = live.begun('tone', 'test', 10, 'live-1')
            # d1 ended before the process went down, d2 was cut mid-conversation.
            ended = next(i for i, item in enumerate(first['items']) if item['dialogueId'] == 'd1')
            cut = 1 - ended
            storage.replays.update_items(
                'live-1',
                {
                    ended: {'conversation': [{'role': 'customer', 'text': 'Сняли дважды'}], 'ended': True},
                    cut: {'conversation': [{'role': 'customer', 'text': 'Как подключить СБП'}], 'ended': False},
                },
            )
            storage.tasks.begin('replay', {'check': 'tone', 'target': 'test', 'count': 10}, task_id='live-1')
            token = storage.tasks.CURRENT.set(storage.tasks.Current('live-1'))
            try:
                record = await live.run('tone', 'test', 10)
            finally:
                storage.tasks.CURRENT.reset(token)
        self.assertEqual(record['status'], 'done')
        self.assertEqual(judge.await_count, 2)
        by_id = {item['dialogueId']: item for item in record['items']}
        self.assertEqual(len(by_id['d1']['conversation']), 1)  # judged as it ended, never played again
        self.assertEqual(by_id['d2']['restarts'], 1)
        self.assertEqual([told[0] for told in self.agent.told.values()], ['Как подключить СБП'])


class LiveStorageTests(unittest.TestCase):
    def setUp(self) -> None:
        support.lab(self)

    def test_a_check_left_running_without_its_task_is_stopped_at_the_start(self) -> None:
        record = {
            'id': 'live-1',
            'check': 'tone',
            'status': 'running',
            'startedAt': '2026-10-07T10:00:00+00:00',
            'topics': TOPICS,
            'items': [item('FAIL', 'RUNNING')],
        }
        storage.replays.create(record)
        self.assertEqual(storage.replays.recover(), 1)
        stopped = storage.replays.get('live-1')
        self.assertEqual((stopped['status'], stopped['items'][0]['status']), ('stopped', 'UNMEASURED'))
        self.assertNotIn('items', storage.replays.summaries()[0])


class LiveApiTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        support.serve(self)

    async def test_a_check_of_the_live_agent_needs_a_result_and_a_known_agent(self) -> None:
        none = await self.client.post('/api/replays', json={'check': 'tone', 'target': 'local-http', 'count': 10})
        self.assertEqual(none.status_code, 400)
        self.assertIn('ещё нет итога', none.json()['detail'])
        unknown = await self.client.post('/api/replays', json={'check': 'tone', 'target': 'nowhere', 'count': 10})
        self.assertEqual(unknown.status_code, 400)
        self.assertEqual((await self.client.get('/api/replays/nothing')).status_code, 404)
        self.assertEqual((await self.client.get('/api/state')).json()['replays'], [])


if __name__ == '__main__':
    unittest.main()
