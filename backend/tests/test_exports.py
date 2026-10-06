"""The exports of real conversations: each upload is an export of its own (storage/exports.py), and how a database of
schema 8, with its one export, becomes one with exports."""

import json
import sqlite3
import unittest

import support

from lab import storage


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
        self.assertEqual((first['name'], first['file'], first['total'], first['skipped']), ('Сентябрь', 'Сентябрь.xlsx', 2, 2))
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
            old.execute('INSERT INTO dialogues VALUES (?, ?, ?)', (position, dialogue_id, json.dumps(talk(dialogue_id))))
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


if __name__ == '__main__':
    unittest.main()
