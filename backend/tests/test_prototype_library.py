"""The prototype's library operations preserve data, rule versions and the old working workflows."""

import json
import unittest
from pathlib import Path

import support

from lab import storage
from lab.domain import checks, export
from lab.domain import judges as rules
from lab.flows import agent_context, connection, datasets, judges


def dialogue(key='d1', question='Как вернуть терминал?'):
    return {'id': key, 'messages': [{'role': 'user', 'content': question}, {'role': 'assistant', 'content': 'Помогу.'}]}


def criterion(text='Обращайтесь к клиенту на вы.'):
    return {'id': 'r1', 'name': 'Обращение', 'text': text, 'quote': text, 'condition': '', 'acceptable': ''}


class DatasetTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        support.serve(self)

    async def test_two_datasets_coexist_and_selection_restores_their_own_result(self):
        first = datasets.add([dialogue()], 'one.jsonl', 'Первый')
        storage.documents.save(checks.result('tone'), {'result': 'first'})
        second = datasets.add([dialogue('d2', 'Другой вопрос')], 'two.jsonl', 'Второй')
        self.assertEqual(len(datasets.listed()['datasets']), 2)
        self.assertIsNone(storage.documents.load(checks.result('tone')))
        datasets.select(first['id'])
        self.assertEqual(storage.dialogues.ids(), ['d1'])
        self.assertEqual(storage.documents.load(checks.result('tone')), {'result': 'first'})
        datasets.select(second['id'])
        self.assertEqual(storage.dialogues.ids(), ['d2'])
        self.assertIsNone(storage.documents.load(checks.result('tone')))

    async def test_changed_rules_do_not_restore_a_stale_current_result(self):
        first = datasets.add([dialogue()], 'first.jsonl')
        storage.documents.save(checks.result('tone'), {'result': 'first'})
        datasets.add([dialogue('d2')], 'second.jsonl')
        storage.documents.save('sources.json', [{'id': checks.TONE_OF_VOICE, 'content': 'Новые правила'}])
        datasets.select(first['id'])
        self.assertIsNone(storage.documents.load(checks.result('tone')))

    async def test_changing_accuracy_inputs_keeps_tone_result_when_switching_datasets(self):
        first = datasets.add([dialogue()], 'first.jsonl')
        storage.documents.save(checks.result('tone'), {'result': 'tone-first'})
        datasets.add([dialogue('d2')], 'second.jsonl')
        storage.documents.save('sources.json', [{'id': 'prompt', 'kind': 'prompt', 'content': 'Новый код'}])
        datasets.select(first['id'])
        self.assertEqual(storage.documents.load(checks.result('tone')), {'result': 'tone-first'})

    async def test_legacy_export_is_adopted_once_without_losing_its_stamp(self):
        storage.dialogues.replace([dialogue()], 'legacy.jsonl')
        before = storage.dialogues.meta()
        first, second = datasets.listed(), datasets.listed()
        self.assertEqual(first, second)
        self.assertEqual(first['datasets'][0]['total'], 1)
        self.assertEqual(storage.dialogues.meta()['updatedAt'], before['updatedAt'])

    async def test_archiving_preserves_evidence_and_can_be_undone(self):
        item = datasets.add([dialogue()], 'one.jsonl')
        datasets.archive(item['id'])
        self.assertEqual(datasets.listed()['datasets'], [])
        self.assertEqual(storage.datasets.page(item['id'], 0, 10), [dialogue()])
        datasets.archive(item['id'], undo=True)
        datasets.select(item['id'])
        self.assertEqual(storage.dialogues.ids(), ['d1'])

    async def test_uploaded_formats_are_real_and_invalid_import_keeps_the_active_dataset(self):
        for name, body in (
            ('one.json', json.dumps([dialogue()])),
            ('two.csv', 'id,role,content\nd2,user,Вопрос\nd2,assistant,Ответ\n'),
        ):
            response = await self.client.post(f'/api/logs?name={name}&title=Название', content=body)
            self.assertEqual(response.status_code, 200, response.text)
        before = storage.dialogues.meta()
        self.assertEqual(len(datasets.listed()['datasets']), 2)
        response = await self.client.post('/api/logs?name=broken.json', content='{')
        self.assertEqual(response.status_code, 400)
        self.assertEqual(storage.dialogues.meta(), before)
        self.assertEqual(export.prepare('single.json', json.dumps(dialogue()).encode()), [dialogue()])


class JudgeLibraryTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        support.serve(self)

    async def test_new_versions_do_not_mutate_old_criteria_and_can_be_selected_again(self):
        policy = 'Всегда обращайтесь к клиенту на вы.'
        first = judges.save('tone', 'Наши правила', policy, [criterion()], None, None)
        second = judges.save(
            'tone', 'Наши правила', policy, [criterion('Не используйте жаргон.')], first['setId'], first['id']
        )
        self.assertEqual(second['version'], 2)
        self.assertEqual(storage.judges.get(first['id'])['criteria'][0]['text'], criterion()['text'])
        judges.activate('tone', first['id'])
        self.assertEqual(
            storage.documents.load('tone-of-voice-criteria.json')['criteria'][0]['text'], criterion()['text']
        )
        self.assertIn('Не используйте жаргон.', judges.markdown(second['id']))
        with self.assertRaisesRegex(ValueError, 'уже изменён'):
            judges.save('tone', 'Наши правила', policy, [criterion()], first['setId'], first['id'])

    async def test_the_lab_offers_no_rules_of_its_own_and_custom_accuracy_is_available(self):
        for kind in ('tone', 'code'):
            listed = (await self.client.get(f'/api/judges/{kind}')).json()
            self.assertEqual(listed, {'versions': [], 'selectedId': None})
        policy = 'Отвечайте только по статьям базы знаний банка.'
        custom = judges.save('code', 'Точность команды', policy, [criterion()], None, None)
        self.assertEqual(storage.judges.active('code')['id'], custom['id'])
        self.assertTrue(any(s['id'] == 'accuracy-judge' for s in storage.documents.load('sources.json')))
        listed = (await self.client.get('/api/judges/code')).json()
        self.assertEqual([version['id'] for version in listed['versions']], [custom['id']])
        self.assertIs(listed['versions'][0]['builtin'], False)
        judges.activate('code', None)
        self.assertIsNone(storage.judges.active('code'))

    async def test_rule_sets_an_earlier_lab_wrote_itself_count_as_none(self):
        """A database may hold the rule sets an earlier Lab wrote itself, selected and copied into the agent's inputs:
        none is offered, found or in force. Tone of voice asks for the person's own rules; accuracy, given no set,
        judges by the agent's code again, without the copied rules."""
        policy = 'Правила, которые написал разработчик Lab, а не банк.'
        written = [
            {
                'id': f'lab-{kind}',
                'setId': f'lab-{kind}-set',
                'kind': kind,
                'name': 'Набор Lab',
                'policy': policy,
                'criteria': [criterion()],
                'builtin': True,
                'version': 1,
                'createdAt': '2026-10-07T08:00:00+00:00',
            }
            for kind in ('tone', 'code')
        ]
        storage.documents.save(storage.judges.LIBRARY, written)
        storage.documents.save('sources.json', [rules.source(kind, 'Набор Lab', policy) for kind in ('tone', 'code')])
        storage.documents.save('tone-of-voice-criteria.json', {'revision': 'lab-tone', 'criteria': [criterion()]})
        storage.documents.save(checks.result('code'), {'checkId': 'judged-by-lab-rules'})
        for kind in ('tone', 'code'):
            storage.judges.select(kind, f'lab-{kind}')
        for kind in ('tone', 'code'):
            with self.subTest(kind=kind):
                self.assertEqual(judges.library(kind), {'versions': [], 'selectedId': None})
                self.assertIsNone(storage.judges.active(kind))
                self.assertIsNone(storage.judges.get(f'lab-{kind}'))
                with self.assertRaisesRegex(ValueError, 'не найден'):
                    judges.activate(kind, f'lab-{kind}')
        judges.activate('code', None)  # «Критерии из кода агента», as a launch of Точность without a set
        self.assertNotIn('accuracy-judge', [source['id'] for source in storage.documents.load('sources.json')])
        self.assertIsNone(storage.documents.load(checks.result('code')))
        mine = judges.save('code', 'Точность команды', policy, [criterion()], 'lab-code-set', 'lab-code')
        self.assertEqual((mine['version'], mine['builtin']), (1, False))
        self.assertEqual([version['id'] for version in storage.judges.listed('code')], [mine['id']])

    async def test_failed_rule_save_is_atomic_and_export_is_the_selected_version(self):
        policy = 'Всегда обращайтесь к клиенту на вы.'
        mine = judges.save('tone', 'Наши правила', policy, [criterion()], None, None)
        response = await self.client.post('/api/judges/tone/select', json={'id': mine['id']})
        self.assertEqual(response.status_code, 200)
        before = storage.documents.load('tone-of-voice-criteria.json')
        response = await self.client.post(
            '/api/judges/tone',
            json={
                'name': 'Новые',
                'policy': policy,
                'criteria': [criterion(), criterion()],
            },
        )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(storage.documents.load('tone-of-voice-criteria.json'), before)
        download = await self.client.get(f'/api/judge-versions/{mine["id"]}/download')
        self.assertIn(policy, download.text)
        self.assertIn('Обращение', download.text)

    async def test_secrets_in_repository_or_idp_urls_are_not_saved_into_versions(self):
        for key in ('repositoryUrl', 'idpUrl'):
            with self.subTest(key=key), self.assertRaises(ValueError):
                agent_context.save({key: 'https://secret-token@example.test/project'})
        self.assertEqual(agent_context.current()['repositoryUrl'], '')
        self.assertEqual(agent_context.current()['idpUrl'], '')

    async def test_a_saved_repository_is_the_agents_code_only_once_it_is_cloned(self):
        """Until its repository is cloned (or when the clone failed), the agent's code is in the folder of the settings,
        never in an empty folder kept for the clone."""
        connection.save_settings({'repo': '~/agents/bank'})
        agent_context.save({'repositoryUrl': 'https://git.example.test/bank/agent.git'})
        self.assertEqual(connection.repo(), Path('~/agents/bank').expanduser())
        (agent_context.checkout_path() / '.git').mkdir(parents=True)
        self.assertEqual(connection.repo(), agent_context.checkout_path())

    async def test_agent_rename_preserves_its_identity_and_database(self):
        agent = storage.registry.create('Первый', '')
        with storage.registry.using(agent['id']):
            storage.dialogues.replace([dialogue()])
        response = await self.client.post(
            '/api/agents/update',
            json={
                'id': agent['id'],
                'name': 'Новое имя',
                'description': 'Описание',
            },
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['id'], agent['id'])
        with storage.registry.using(agent['id']):
            self.assertEqual(storage.dialogues.ids(), ['d1'])
