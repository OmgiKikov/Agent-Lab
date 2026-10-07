"""Recorded questions are replayed; grouped modes recover without rerunning successes."""

import asyncio
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import support
from test_prototype_library import criterion, dialogue

from lab import storage
from lab.agents import idp
from lab.domain import checks
from lab.domain.comparison import comparison
from lab.flows import agent_context, datasets, judges, launches, questions, tone
from lab.roles import judge


class Agent:
    version = 'v-test'
    mocked = False

    def __init__(self):
        self.said = []
        self.closed = False

    async def open(self):
        pass

    async def close(self):
        self.closed = True

    async def say(self, conversation_id, question, test_data=None):
        self.said.append((conversation_id, question))
        return {'ok': True, 'text': 'Новый ответ: ' + question}


def verdict(dialog, topic):
    return {
        'rules': [
            {'ruleId': 'r1', 'rule': 'Обращение', 'status': 'PASS', 'reason': 'Проверено', 'agentQuote': 'Новый ответ'}
        ],
        'status': 'PASS',
        'model': 'test',
        'judgeVersion': '1',
        'error': None,
        'second': None,
    }


class QuestionTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        support.serve(self)
        self.dataset = datasets.add([dialogue()], 'dialogs.json')
        self.rules = judges.save('tone', 'Правила', 'Всегда обращайтесь к клиенту на вы.', [criterion()], None, None)

    async def test_exact_client_turns_are_replayed_with_a_fresh_conversation_and_original_saved(self):
        original = dialogue()
        original['messages'] += [
            {'role': 'user', 'content': 'А где это сделать?'},
            {'role': 'assistant', 'content': 'Старый ответ'},
        ]
        datasets.add([original], 'two-turns.json')
        agent = Agent()
        with (
            patch('lab.flows.connection.connect', return_value=agent),
            patch('lab.flows.conversations.judge_dialogue', new=AsyncMock(side_effect=verdict)),
        ):
            result = await questions.run('tone', 'prod', 10, lambda **_: None, 'questions-test')
        self.assertEqual(result['status'], 'done')
        self.assertEqual([text for _, text in agent.said], ['Как вернуть терминал?', 'А где это сделать?'])
        self.assertEqual(len({key for key, _ in agent.said}), 1)
        self.assertTrue(agent.closed)
        self.assertEqual(result['items'][0]['original'], original['messages'])
        self.assertEqual(result['metric']['passed'], 1)
        self.assertNotIn('questions-test', [r['id'] for r in storage.runs.summaries()])

    async def test_questions_do_not_claim_improvement_after_the_judges_context_changed(self):
        selected = judges.save('code', 'Точность', 'Следуйте доступным инструментам агента.', [criterion()], None, None)
        baseline = {
            'topics': [{'id': 'custom', 'rules': selected['criteria']}],
            'agentContext': {'tools': ['old-tool']},
            'results': [
                {
                    'dialogueId': 'd1',
                    'topicId': 'custom',
                    'status': 'FAIL',
                    'model': 'test',
                    'judgeVersion': '1',
                    'knowledge': None,
                }
            ],
        }
        storage.documents.save(checks.result('code'), baseline)
        agent_context.save({'tools': ['new-tool']})
        with (
            patch('lab.flows.connection.connect', return_value=Agent()),
            patch('lab.flows.conversations.judge_dialogue', new=AsyncMock(side_effect=verdict)),
        ):
            result = await questions.run('code', 'local-http', 1, lambda **_: None, 'changed-context')
        self.assertEqual(result['items'][0]['status'], 'PASS')
        self.assertFalse(result['items'][0]['comparable'])

    async def test_failed_connection_is_never_a_successful_check(self):
        with patch('lab.flows.connection.connect', side_effect=RuntimeError('Нет связи')):
            result = await questions.run('tone', 'prod', 10, lambda **_: None, 'unreachable')
        self.assertEqual(result['status'], 'failed')
        self.assertEqual(result['metric']['measured'], 0)
        self.assertEqual(result['items'][0]['status'], 'UNMEASURED')
        self.assertIn('Нет связи', result['error'])

    async def test_all_three_modes_have_their_own_result_and_frozen_configuration(self):
        given = {
            'check': 'tone',
            'datasetId': self.dataset['id'],
            'judgeId': self.rules['id'],
            'count': 1,
            'target': 'local-http',
            'agentVersion': 'v-release',
            'modes': ['dataset', 'questions', 'simulations'],
        }
        launches.prepare(given)
        metric = {'passed': 1, 'failed': 0, 'measured': 1, 'unmeasured': 0, 'total': 1, 'accuracy': 100}

        async def checked(*args, **kwargs):
            storage.documents.save(tone.RESULT, {'checkId': 'baseline', 'summary': metric})

        async def built(*args, **kwargs):
            storage.documents.save(checks.DECK, {'check': 'tone', 'cards': [{'id': 'c1'}]})

        with (
            patch('lab.flows.tone.check', new=AsyncMock(side_effect=checked)),
            patch(
                'lab.flows.questions.run', new=AsyncMock(return_value={'id': 'q', 'status': 'done', 'metric': metric})
            ),
            patch('lab.flows.scenarios.build', new=AsyncMock(side_effect=built)),
            patch(
                'lab.flows.simulation.run',
                new=AsyncMock(return_value={'id': 'sim', 'status': 'done', 'metric': metric}),
            ),
        ):
            result = await launches.run(given, lambda **_: None)
        self.assertEqual(result['status'], 'done')
        self.assertEqual(set(result['modes']), {'dataset', 'questions', 'simulations'})
        self.assertEqual(result['dataset']['datasetId'], self.dataset['id'])
        self.assertEqual(result['judge']['id'], self.rules['id'])
        self.assertEqual(result['agentVersion'], 'v-release')
        self.assertNotIn('average', result)

    async def test_grouped_check_preserves_native_severity_proposals(self):
        for check, flow in [('tone', 'tone'), ('code', 'accuracy')]:
            with self.subTest(check=check):

                async def checked(*args, selected=check, **kwargs):
                    storage.documents.save(checks.result(selected), {'checkId': 'saved', 'summary': {}})

                with (
                    patch(f'lab.flows.{flow}.check', new=AsyncMock(side_effect=checked)),
                    patch('lab.flows.severity.propose', new=AsyncMock(return_value=None)) as propose,
                ):
                    result = await launches._check({'check': check, 'count': 1}, lambda **_: None)
                self.assertEqual(result['checkId'], 'saved')
                self.assertEqual(propose.await_args.args[0], check)

    async def test_stopping_severity_does_not_start_remaining_launch_modes(self):
        given = {'check': 'tone', 'count': 1, 'modes': ['dataset', 'questions']}

        async def checked(*args, **kwargs):
            storage.documents.save(tone.RESULT, {'checkId': 'saved', 'summary': {}})

        with (
            patch('lab.flows.tone.check', new=AsyncMock(side_effect=checked)),
            patch('lab.flows.severity.propose', new=AsyncMock(side_effect=asyncio.CancelledError)),
            patch('lab.flows.questions.run', new=AsyncMock()) as replay,
            self.assertRaises(asyncio.CancelledError),
        ):
            await launches.run(given, lambda **_: None)
        replay.assert_not_awaited()
        self.assertEqual(storage.documents.load(tone.RESULT)['checkId'], 'saved')
        record = storage.launches.listed('launch')[0]
        self.assertEqual(record['status'], 'stopped')
        self.assertEqual(record['modes']['questions']['status'], 'pending')

    async def test_real_pipeline_publishes_history_questions_and_simulation(self):
        def judged(rules, shown, *args, **kwargs):
            text = next(row['text'] for row in shown if row['role'] == 'AGENT')
            status = 'PASS' if text.startswith('Новый ответ') else 'FAIL'
            rows = [
                {
                    'ruleId': r['id'],
                    'rule': r['text'],
                    'status': status,
                    'reason': 'Тестовый вердикт',
                    'agentQuote': text,
                    'title': r['name'],
                }
                for r in rules
            ]
            return judge.Verdict(rows, status, 'test-model', 'test-judge')

        async def run_judged(evidence, *args, **kwargs):
            return judged(evidence.criteria, evidence.payload['conversation'])

        agent = Agent()
        situation = SimpleNamespace(
            value=SimpleNamespace(name='Возврат терминала', situation='Клиент хочет вернуть терминал.'), model='test'
        )
        given = {
            'check': 'tone',
            'datasetId': self.dataset['id'],
            'judgeId': self.rules['id'],
            'count': 1,
            'target': 'local-http',
            'agentVersion': 'v-checkpoint',
            'modes': ['dataset', 'questions', 'simulations'],
        }
        with (
            patch('lab.flows.connection.connect', return_value=agent),
            patch('lab.roles.judge.log_verdict', new=AsyncMock(side_effect=judged)),
            patch('lab.roles.judge.run_verdict', new=AsyncMock(side_effect=run_judged)),
            patch('lab.roles.scenario.scenario', new=AsyncMock(return_value=situation)),
            patch(
                'lab.roles.severity.propose',
                new=AsyncMock(
                    return_value=SimpleNamespace(
                        value={'c1': {'serious': False, 'reason': 'Тестовое предложение'}},
                        model='test',
                    )
                ),
            ),
            patch(
                'lab.roles.customer.reply', new=AsyncMock(return_value=SimpleNamespace(value='[КОНЕЦ]', model='test'))
            ),
            patch('lab.agents.world.templates', return_value=None),
            patch('lab.agents.knowledge.retrieved', return_value=[]),
        ):
            response = await self.client.post('/api/launches', json=given)
            self.assertEqual(response.status_code, 200, response.text)
            launch_id = response.json()['id']
            for _ in range(200):
                if not self.jobs.state['running']:
                    break
                await asyncio.sleep(0.01)
            self.assertFalse(self.jobs.state['running'])
        result = storage.launches.get('launch', launch_id)
        self.assertEqual(result['status'], 'done', result)
        self.assertTrue(storage.severity.proposed()['tone']['proposals'])
        baseline = storage.history.get('tone', result['modes']['dataset']['checkId'])
        self.assertEqual(baseline['check']['dataset']['datasetId'], self.dataset['id'])
        self.assertEqual(baseline['check']['agentVersion'], 'v-checkpoint')
        replay = storage.launches.get('questions', result['modes']['questions']['questionsId'])
        self.assertEqual(replay['items'][0]['status'], 'PASS')
        self.assertEqual(replay['items'][0]['baseline']['status'], 'FAIL')
        self.assertTrue(replay['items'][0]['comparable'])
        simulation = storage.runs.get(result['modes']['simulations']['runId'])
        self.assertEqual(simulation['status'], 'done')
        self.assertEqual(simulation['items'][0]['status'], 'PASS')
        judges.save(
            'tone',
            'Новый набор',
            'Теперь действуют другие правила общения.',
            [criterion('Другие требования.')],
            None,
            None,
        )
        datasets.archive(self.dataset['id'])
        self.assertEqual(storage.history.get('tone', baseline['check']['id']), baseline)
        self.assertEqual(
            storage.launches.get('questions', replay['id'])['items'][0]['original'], dialogue()['messages']
        )

    async def test_stopping_a_group_marks_the_active_mode_stopped_and_can_resume(self):
        from lab.api import work

        given = {
            'check': 'tone',
            'datasetId': self.dataset['id'],
            'judgeId': self.rules['id'],
            'count': 1,
            'target': 'local-http',
            'agentVersion': '',
            'modes': ['questions'],
        }
        entered = asyncio.Event()

        async def slow(*args):
            entered.set()
            await asyncio.Event().wait()

        with patch('lab.flows.launches._mode', new=AsyncMock(side_effect=slow)):
            first = work.start(self.jobs, 'launch', launches.prepare(given))
            await asyncio.wait_for(entered.wait(), 1)
            await self.jobs.stop()
        stopped = storage.launches.get('launch', first['task'])
        self.assertEqual(stopped['status'], 'stopped')
        self.assertEqual(stopped['modes']['questions']['status'], 'stopped')
        with patch('lab.flows.launches._mode', new=AsyncMock(return_value={'status': 'done'})):
            resumed = work.start(self.jobs, 'launch', launches.prepare(given))
            for _ in range(100):
                if not self.jobs.state['running']:
                    break
                await asyncio.sleep(0.01)
        self.assertEqual(resumed['task'], first['task'])
        self.assertEqual(storage.launches.get('launch', resumed['task'])['status'], 'done')

    async def test_partial_launch_retry_does_not_rerun_completed_modes(self):
        from lab.api import work

        given = {
            'check': 'tone',
            'datasetId': self.dataset['id'],
            'judgeId': self.rules['id'],
            'count': 1,
            'target': 'local-http',
            'agentVersion': '',
            'modes': ['dataset', 'questions'],
        }
        calls = []

        async def mode(name, *args):
            calls.append(name)
            if name == 'questions' and calls.count('questions') == 1:
                raise ValueError('Временный сбой')
            return {'status': 'done'}

        async def wait():
            for _ in range(100):
                if not self.jobs.state['running']:
                    return
                await asyncio.sleep(0.01)
            self.fail('job did not finish')

        with patch('lab.flows.launches._mode', new=AsyncMock(side_effect=mode)):
            first = work.start(self.jobs, 'launch', launches.prepare(given))
            await wait()
            second = work.start(self.jobs, 'launch', launches.prepare(given))
            await wait()
        self.assertEqual(first['task'], second['task'])
        self.assertEqual(calls.count('dataset'), 1)
        self.assertEqual(calls.count('questions'), 2)
        self.assertEqual(storage.launches.get('launch', first['task'])['status'], 'done')


class IdpTests(unittest.TestCase):
    def test_changed_knowledge_cannot_be_reported_as_an_agent_improvement(self):
        before = {
            'id': 'old',
            'criteriaFingerprint': 'rules',
            'evaluationFingerprint': 'judge',
            'datasetFingerprint': 'same',
            'knowledgeFingerprint': 'before',
        }
        after = before | {'id': 'new', 'knowledgeFingerprint': 'after'}
        self.assertEqual(comparison(after, before)['kind'], 'incompatible')
        self.assertEqual(comparison(after | {'datasetFingerprint': 'other'}, before)['kind'], 'new-data')

    def test_contract_passes_the_actual_index_and_reads_only_returned_sources(self):
        request = idp.request('Вопрос', 'index-1', 'embedder-1', 'Поддержка/*')
        self.assertEqual(request['configuration']['agent_configuration']['data_sources'], [{'index_id': 'index-1'}])
        self.assertFalse(request['configuration']['agent_configuration']['qa']['enabled'])
        found = idp.passages(
            {
                'result': {
                    'response': {
                        'messages': [
                            {
                                'sources': [
                                    {'content': 'Правило возврата', 'metadata': {'index': 7}},
                                ]
                            }
                        ]
                    }
                }
            }
        )
        self.assertEqual(found[0]['text'], 'Правило возврата')
        self.assertEqual(idp.passages({'result': {'response': {'messages': []}}}), [])


class IdpHttpTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        support.lab(self, idp_key='test-token', idp_source_id='lab-source', idp_sender='lab', idp_receiver='idp')

    async def test_http_adapter_sends_index_authentication_and_routing_and_returns_real_passages(self):
        import json

        import httpx

        seen = []

        def handler(request):
            seen.append(request)
            return httpx.Response(
                200,
                json={
                    'result': {
                        'response': {
                            'messages': [
                                {
                                    'sources': [
                                        {'content': 'Реальный фрагмент ответа сервиса', 'metadata': {'index': 1}},
                                    ]
                                }
                            ]
                        }
                    }
                },
            )

        client = httpx.AsyncClient
        with patch(
            'lab.agents.idp.httpx.AsyncClient',
            side_effect=lambda **kwargs: client(transport=httpx.MockTransport(handler), **kwargs),
        ):
            found = await idp.retrieve(
                {
                    'idpUrl': 'https://idp.test/predict',
                    'idpIndex': 'dataset-index',
                    'idpEmbedder': 'embedder',
                    'idpFilter': '',
                },
                'Вопрос',
            )
        body = json.loads(seen[0].content)
        self.assertEqual(seen[0].headers['Authorization'], 'Bearer test-token')
        self.assertEqual(body['meta']['source_uuid'], 'lab-source')
        self.assertEqual(body['msgProperties'], {'sender': 'lab', 'receiver': 'idp'})
        self.assertEqual(body['configuration']['agent_configuration']['data_sources'], [{'index_id': 'dataset-index'}])
        self.assertEqual(found[0]['text'], 'Реальный фрагмент ответа сервиса')
