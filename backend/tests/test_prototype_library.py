"""The prototype's library operations preserve data, rule versions and the old working workflows."""

import json
import unittest

import support

from lab import storage
from lab.domain import checks, export
from lab.flows import agent_context, datasets, judges


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

    async def test_builtin_sets_are_real_readonly_and_custom_accuracy_is_available(self):
        built = judges.library('code')['versions'][0]
        self.assertTrue(built['builtin'])
        self.assertEqual(len(built['criteria']), 3)
        with self.assertRaisesRegex(ValueError, 'Встроенный'):
            judges.save('code', built['name'], built['policy'], built['criteria'], built['setId'], built['id'])
        custom = judges.save('code', 'Точность команды', built['policy'], [criterion()], None, None)
        self.assertEqual(storage.judges.active('code')['id'], custom['id'])
        self.assertTrue(any(s['id'] == 'accuracy-judge' for s in storage.documents.load('sources.json')))
        judges.activate('code', None)
        self.assertIsNone(storage.judges.active('code'))

    async def test_failed_rule_save_is_atomic_and_export_is_the_selected_version(self):
        built = judges.library('tone')['versions'][0]
        response = await self.client.post('/api/judges/tone/select', json={'id': built['id']})
        self.assertEqual(response.status_code, 200)
        before = storage.documents.load('tone-of-voice-criteria.json')
        response = await self.client.post(
            '/api/judges/tone',
            json={
                'name': 'Новые',
                'policy': built['policy'],
                'criteria': [criterion(), criterion()],
            },
        )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(storage.documents.load('tone-of-voice-criteria.json'), before)
        download = await self.client.get(f'/api/judge-versions/{built["id"]}/download')
        self.assertIn(built['policy'], download.text)
        self.assertIn('Обращение', download.text)

    async def test_secrets_in_repository_or_idp_urls_are_not_saved_into_versions(self):
        for key in ('repositoryUrl', 'idpUrl'):
            with self.subTest(key=key), self.assertRaises(ValueError):
                agent_context.save({key: 'https://secret-token@example.test/project'})
        self.assertEqual(agent_context.current()['repositoryUrl'], '')
        self.assertEqual(agent_context.current()['idpUrl'], '')

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
