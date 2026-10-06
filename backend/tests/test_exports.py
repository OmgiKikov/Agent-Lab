"""The exports of real conversations: each upload is an export of its own (storage/exports.py), and how a database of
schema 8, with its one export, becomes one with exports."""

import json
import sqlite3
import unittest

import support

from lab import storage
from lab.domain import checks
from lab.flows import conversations, inputs


def talk(dialogue_id: str, text: str = 'Вопрос') -> dict:
    return {
        'id': dialogue_id,
        'messages': [{'role': 'user', 'content': text}, {'role': 'assistant', 'content': 'Ответ'}],
    }


class ExportsTests(unittest.TestCase):
    def setUp(self) -> None:
        support.lab(self)

    def test_an_upload_is_an_export_of_its_own(self) -> None:
        first = storage.exports.add([talk('a'), talk('b')], 'Сентябрь.xlsx', skipped=2)
        second = storage.exports.add([talk('c')], 'export-16-09.jsonl', 'Октябрь')
        self.assertEqual([e['id'] for e in storage.exports.listed()], [second['id'], first['id']])
        self.assertEqual(
            (first['name'], first['file'], first['total'], first['skipped']), ('Сентябрь', 'Сентябрь.xlsx', 2, 2)
        )
        self.assertEqual(second['name'], 'Октябрь')
        self.assertEqual(storage.exports.ids(first['id']), ['a', 'b'])
        self.assertEqual(storage.exports.read(first['id'], ['b']), [talk('b')])
        self.assertEqual(storage.exports.newest()['id'], second['id'])
        self.assertTrue(storage.exports.uploaded())

    def test_one_id_in_two_exports(self) -> None:
        old = storage.exports.add([talk('d1', 'Старый')], 'a.xlsx')
        new = storage.exports.add([talk('d1', 'Новый')], 'b.xlsx')
        self.assertEqual(storage.exports.conversation(old['id'], 'd1')['messages'][0]['content'], 'Старый')
        self.assertEqual(storage.exports.conversation(new['id'], 'd1')['messages'][0]['content'], 'Новый')
        storage.exports.remove(old['id'])
        self.assertIsNone(storage.exports.conversation(old['id'], 'd1'))
        self.assertEqual(storage.exports.ids(new['id']), ['d1'])

    def test_rename_and_remove(self) -> None:
        found = storage.exports.add([talk('a')], 'x.xlsx')
        self.assertEqual(storage.exports.rename(found['id'], ' Сентябрь ')['name'], 'Сентябрь')
        self.assertIsNone(storage.exports.rename('nope', 'X'))
        self.assertEqual(storage.exports.remove(found['id'])['id'], found['id'])
        self.assertIsNone(storage.exports.remove(found['id']))
        self.assertEqual(storage.exports.listed(), [])
        self.assertFalse(storage.exports.uploaded())

    def test_an_export_without_conversations_is_nothing_to_check(self) -> None:
        storage.exports.add([], 'пустая.xlsx', skipped=3)
        self.assertEqual(storage.exports.newest()['total'], 0)
        self.assertFalse(storage.exports.uploaded())

    def test_the_name_of_a_file(self) -> None:
        self.assertEqual(storage.exports.name_of('Выгрузка чата 09.2026.xlsx'), 'Выгрузка чата 09.2026')
        self.assertEqual(storage.exports.name_of('C:\\Users\\me\\export.jsonl'), 'export')
        self.assertEqual(storage.exports.name_of(None), 'Выгрузка')


class SchemaNineTests(unittest.TestCase):
    def setUp(self) -> None:
        support.lab(self)

    def test_schema_8_becomes_9(self) -> None:
        """The one export of a database of schema 8 becomes its first export, named by its file and uploaded when it
        was; the current result was made of it, and so was the saved check it is."""
        path = storage.db.default_database()
        storage.db.private_folder(path.parent)
        old = sqlite3.connect(path)
        old.execute('CREATE TABLE documents (name TEXT PRIMARY KEY, value TEXT NOT NULL)')
        old.execute(
            'CREATE TABLE dialogues (position INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, value TEXT NOT NULL)'
        )
        old.execute(
            'CREATE TABLE history (id TEXT PRIMARY KEY, kind TEXT NOT NULL, summary TEXT NOT NULL, value TEXT NOT NULL)'
        )
        for position, dialogue_id in enumerate(['d1', 'd2'], 1):
            old.execute(
                'INSERT INTO dialogues VALUES (?, ?, ?)', (position, dialogue_id, json.dumps(talk(dialogue_id)))
            )
        meta = {'file': 'Сентябрь.xlsx', 'updatedAt': '2026-10-02T10:00:00.000+00:00'}
        result = {'checkId': 'c1', 'purpose': 'tone-of-voice', 'results': [], 'topics': []}
        for name, value in (('logs-meta.json', meta), ('tone-result.json', result)):
            old.execute('INSERT INTO documents VALUES (?, ?)', (name, json.dumps(value)))
        line = {'id': 'c1', 'file': 'Сентябрь.xlsx', 'total': 2}
        old.execute(
            'INSERT INTO history VALUES (?, ?, ?, ?)', ('c1', 'tone', json.dumps(line), json.dumps({'check': line}))
        )
        old.execute('PRAGMA user_version = 8')
        old.commit()
        old.close()

        [export] = storage.exports.listed()
        self.assertEqual(
            (export['name'], export['file'], export['uploadedAt'], export['total']),
            ('Сентябрь', 'Сентябрь.xlsx', meta['updatedAt'], 2),
        )
        self.assertEqual(storage.exports.ids(export['id']), ['d1', 'd2'])
        made = {'id': export['id'], 'name': 'Сентябрь', 'file': 'Сентябрь.xlsx', 'total': 2}
        self.assertEqual(storage.documents.load('tone-result.json')['export'], made)
        named = {'id': export['id'], 'name': 'Сентябрь'}
        self.assertEqual(storage.history.lines('tone')[0]['export'], named)
        self.assertEqual(storage.history.get('tone', 'c1')['check']['export'], named)
        self.assertFalse(storage.documents.exists('logs-meta.json'))

    def test_a_database_without_an_export_gets_none(self) -> None:
        self.assertEqual(storage.exports.listed(), [])


class ExportFlowTests(unittest.TestCase):
    """What an export changes: an upload nothing, a removal the result made of it."""

    def setUp(self) -> None:
        support.lab(self)

    def test_an_upload_clears_nothing(self) -> None:
        storage.documents.save('tone-result.json', {'purpose': 'tone-of-voice', 'results': []})
        storage.documents.save('discover.json', {'topics': [], 'results': []})
        storage.documents.save('cards.json', {'check': 'tone', 'cards': [{'id': 'card-1'}]})
        inputs.add_export([talk('a')], 'Октябрь.xlsx')
        for name in ('tone-result.json', 'discover.json', 'cards.json'):
            self.assertIsNotNone(storage.documents.load(name), name)

    def test_removing_the_export_of_a_result_sends_it_to_the_history(self) -> None:
        kept = inputs.add_export([talk('a')], 'Сентябрь.xlsx')
        gone = inputs.add_export([talk('b')], 'Октябрь.xlsx')
        storage.documents.save('tone-result.json', {'purpose': 'tone-of-voice', 'results': [], 'export': gone})
        storage.documents.save('discover.json', {'topics': [], 'results': [], 'export': kept})
        storage.documents.save('cards.json', {'check': 'tone', 'cards': [{'id': 'card-1'}]})
        self.assertEqual(inputs.remove_export(gone['id'])['id'], gone['id'])
        self.assertIsNone(storage.documents.load('tone-result.json'))
        self.assertIsNone(storage.documents.load('cards.json'))
        self.assertIsNotNone(storage.documents.load('discover.json'))
        self.assertEqual([e['id'] for e in storage.exports.listed()], [kept['id']])
        with self.assertRaisesRegex(LookupError, 'Выгрузки уже нет'):
            inputs.remove_export(gone['id'])

    def test_removing_the_export_of_accuracy_keeps_its_criteria(self) -> None:
        gone = inputs.add_export([talk('a')], 'Сентябрь.xlsx')
        topics = [{'id': 't', 'title': 'Тема', 'rules': [{'id': 'r'}], 'dialogueIds': ['a']}]
        storage.documents.save('discover.json', {'topics': topics, 'results': [], 'export': gone})
        inputs.remove_export(gone['id'])
        self.assertIsNone(storage.documents.load('discover.json'))
        self.assertEqual(storage.documents.load(checks.CODE_CRITERIA)['topics'][0]['dialogueIds'], [])

    def test_a_check_takes_its_sample_from_the_chosen_export(self) -> None:
        first = inputs.add_export([talk('a'), talk('b')], 'a.xlsx')
        second = inputs.add_export([talk('c')], 'b.xlsx')
        self.assertEqual({d['id'] for d in conversations.sample(first['id'], 5)}, {'a', 'b'})
        self.assertEqual(conversations.chosen(None)['id'], second['id'])
        self.assertEqual(conversations.chosen(first['id'])['id'], first['id'])
        with self.assertRaisesRegex(ValueError, 'Выгрузка удалена'):
            conversations.chosen('nope')

    def test_without_an_export_there_is_nothing_to_choose(self) -> None:
        with self.assertRaisesRegex(ValueError, 'Сначала загрузите выгрузку'):
            conversations.chosen(None)

    def test_the_same_work_is_the_same_export(self) -> None:
        first = inputs.add_export([talk('a')], 'a.xlsx')
        second = inputs.add_export([talk('a')], 'a.xlsx')
        self.assertNotEqual(conversations.same_material(first['id'], 5), conversations.same_material(second['id'], 5))
        self.assertEqual(conversations.same_material(None, 5), conversations.same_material(second['id'], 5))

    def test_a_result_that_names_no_export_is_of_none(self) -> None:
        inputs.add_export([talk('a')], 'a.xlsx')
        self.assertIsNone(conversations.export_of({'results': []}))
        self.assertEqual(conversations.export_of({'export': {'id': 'other'}}), 'other')


class ExportsApiTests(unittest.IsolatedAsyncioTestCase):
    """The section «Выгрузки»: upload, the list with the checks made of each, rename, delete and conversations."""

    async def asyncSetUp(self) -> None:
        support.serve(self)

    async def upload(self, *talks: dict, file: str = 'x.jsonl', title: str = '') -> dict:
        body = '\n'.join(json.dumps(t, ensure_ascii=False) for t in talks).encode()
        query = f'/api/exports?name={file}' + (f'&title={title}' if title else '')
        response = await self.client.post(query, content=body)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    async def test_upload_list_rename_and_delete(self) -> None:
        first = await self.upload(talk('a'), file='Сентябрь.jsonl')
        second = await self.upload(talk('a'), file='b.jsonl', title='Октябрь')
        self.assertEqual((first['name'], first['total'], second['name']), ('Сентябрь', 1, 'Октябрь'))
        listed = (await self.client.get('/api/exports')).json()['exports']
        self.assertEqual([e['name'] for e in listed], ['Октябрь', 'Сентябрь'])
        self.assertEqual(listed[0]['checks'], {'tone': None, 'code': None})
        renamed = await self.client.post(f'/api/exports/{first["id"]}/rename', json={'name': 'Сентябрь, весь'})
        self.assertEqual(renamed.json()['name'], 'Сентябрь, весь')
        self.assertEqual((await self.client.post('/api/exports/nope/rename', json={'name': 'X'})).status_code, 404)
        state = (await self.client.get('/api/state')).json()
        self.assertEqual([e['id'] for e in state['exports']], [second['id'], first['id']])
        gone = await self.client.post(f'/api/exports/{second["id"]}/delete')
        self.assertEqual(gone.json(), {'removed': second | {'name': 'Октябрь'}, 'cleared': []})
        self.assertEqual((await self.client.post(f'/api/exports/{second["id"]}/delete')).status_code, 404)

    async def test_the_list_names_the_latest_check_made_of_each_export(self) -> None:
        export = await self.upload(talk('a'))
        line = {
            'id': 'c1',
            'finishedAt': '2026-10-02T10:00:00+00:00',
            'summary': {'measured': 2, 'passed': 1, 'failed': 1, 'unmeasured': 0},
            'export': {'id': export['id'], 'name': 'x'},
        }
        storage.history.save('tone', {'check': line, 'result': {}})
        storage.documents.save('tone-result.json', {'checkId': 'c1', 'export': export, 'results': []})
        [listed] = (await self.client.get('/api/exports')).json()['exports']
        self.assertEqual(
            listed['checks']['tone'],
            {'id': 'c1', 'finishedAt': line['finishedAt'], 'summary': line['summary'], 'current': True},
        )
        self.assertIsNone(listed['checks']['code'])

    async def test_deleting_the_export_of_a_result_says_which_went(self) -> None:
        export = await self.upload(talk('a'))
        storage.documents.save('discover.json', {'topics': [], 'results': [], 'export': export})
        gone = (await self.client.post(f'/api/exports/{export["id"]}/delete')).json()
        self.assertEqual(gone['cleared'], ['code'])

    async def test_nothing_is_deleted_while_another_task_runs(self) -> None:
        export = await self.upload(talk('a'))
        with support.running('discover'):
            response = await self.client.post(f'/api/exports/{export["id"]}/delete')
        self.assertEqual(response.status_code, 409)
        self.assertEqual(len(storage.exports.listed()), 1)

    async def test_conversations_of_an_export_in_pages(self) -> None:
        export = await self.upload(*(talk(f'd{n}', f'Вопрос  {n}\nещё') for n in range(3)))
        page = (await self.client.get(f'/api/exports/{export["id"]}/conversations?offset=1&limit=1')).json()
        self.assertEqual(page, {'total': 3, 'items': [{'id': 'd1', 'first': 'Вопрос 1 ещё', 'turns': 2}]})
        one = (await self.client.get(f'/api/exports/{export["id"]}/conversations/d2')).json()
        self.assertEqual(one['messages'][0]['content'], 'Вопрос  2\nещё')
        self.assertEqual((await self.client.get('/api/exports/nope/conversations')).status_code, 404)
        missing = await self.client.get(f'/api/exports/{export["id"]}/conversations/nope')
        self.assertEqual(missing.status_code, 404)

    async def test_an_unreadable_file_is_refused(self) -> None:
        response = await self.client.post('/api/exports?name=broken.xlsx', content=b'not a workbook')
        self.assertEqual(response.status_code, 400)
        self.assertEqual(storage.exports.listed(), [])


if __name__ == '__main__':
    unittest.main()
