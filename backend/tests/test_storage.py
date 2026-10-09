import contextvars
import json
import sqlite3
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

import support

from lab import config, storage
from lab.flows import answers, datasets, inputs
from lab.migrate import migrate
from lab.storage import legacy as legacy_import


def record() -> dict:
    return {
        'id': 'run-1',
        'startedAt': '2026-09-30T10:00:00+00:00',
        'status': 'running',
        'items': [{'cardId': 'card-1', 'status': 'RUNNING', 'conversation': [], 'review': None}],
    }


class StoreTests(unittest.TestCase):
    def setUp(self) -> None:
        self.settings = support.lab(self)
        self.path = self.settings.data

    def test_producer_patch_preserves_review_and_recomputes_metric(self) -> None:
        stale = record()
        stale['items'][0].update(status='PASS', rules=[{'status': 'PASS'}])
        storage.runs.create(stale)
        answers.on_run('run-1', 0, 'disagree')
        stale['items'][0].update(stage='finished')
        result = storage.runs.update_item('run-1', 0, stale['items'][0])
        self.assertEqual(result['items'][0]['review'], 'disagree')
        self.assertEqual(result['metric']['accuracy'], 100)
        self.assertEqual(result['metric']['human'], {'reviewed': 1, 'agree': 0})
        self.assertEqual(result['revision'], 2)  # the answer is kept apart: only the patch changed the run
        self.assertTrue(result['updatedAt'])

    def test_concurrent_review_and_progress_do_not_overwrite_each_other(self) -> None:
        source = record()
        source['items'][0]['status'] = 'PASS'
        storage.runs.create(source)

        def progress() -> None:
            for index in range(12):
                storage.runs.update_item('run-1', 0, {'stage': str(index), 'status': 'PASS', 'review': None})

        def review() -> None:
            for _ in range(12):
                answers.on_run('run-1', 0, 'agree')

        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(contextvars.copy_context().run, work) for work in (progress, review)]
            for future in futures:
                future.result()
        result = storage.runs.get('run-1')
        self.assertEqual(result['items'][0]['review'], 'agree')
        self.assertEqual(result['items'][0]['stage'], '11')
        self.assertEqual(result['revision'], 13)  # created, then twelve patches; the answers are rows of their own

    def test_full_run_replacement_is_not_an_update_operation(self) -> None:
        storage.runs.create(record())
        with self.assertRaises(ValueError):
            storage.runs.update('run-1', items=[])
        self.assertEqual(len(storage.runs.get('run-1')['items']), 1)

    def test_migration_is_explicit_repeatable_and_preserves_files_and_new_reviews(self) -> None:
        legacy = self.path / 'legacy'
        (legacy / 'runs').mkdir(parents=True)
        source = record()
        source.update(status='done')
        source['items'][0].update(status='PASS', rules=[{'status': 'PASS'}], review='disagree')
        run_file = legacy / 'runs' / 'run-1.json'
        original = json.dumps(source)
        run_file.write_text(original)
        (legacy / 'settings.json').write_text('{"repo":"/agent"}')
        (legacy / 'logs.jsonl').write_text(
            json.dumps(
                {
                    'id': 'dialogue-1',
                    'messages': [{'role': 'user', 'content': 'question'}, {'role': 'assistant', 'content': 'answer'}],
                }
            )
            + '\n'
        )
        self.assertIsNone(storage.runs.get('run-1'))
        self.assertEqual(migrate(legacy), {'documents': 2, 'runs': 1, 'recomputedVerdicts': 0, 'resetReviews': 0})
        self.assertEqual(storage.dialogues.read()[0]['id'], 'dialogue-1')
        self.assertEqual(storage.runs.get('run-1')['items'][0]['review'], 'disagree')
        answers.on_run('run-1', 0, 'agree')
        self.assertEqual(migrate(legacy), {'documents': 0, 'runs': 0, 'recomputedVerdicts': 0, 'resetReviews': 0})
        self.assertEqual(storage.runs.get('run-1')['items'][0]['review'], 'agree')
        self.assertEqual(run_file.read_text(), original)

    def test_interrupted_legacy_run_gets_terminal_status(self) -> None:
        legacy = self.path / 'legacy'
        (legacy / 'runs').mkdir(parents=True)
        (legacy / 'runs' / 'run-1.json').write_text(json.dumps(record()))
        migrate(legacy)
        result = storage.runs.get('run-1')
        self.assertEqual(result['status'], 'stopped')
        self.assertEqual(result['items'][0]['status'], 'UNMEASURED')
        self.assertTrue(result['finishedAt'])

    def test_migration_normalizes_log_ids_and_reaggregates_existing_evidence(self) -> None:
        legacy = self.path / 'legacy'
        (legacy / 'runs').mkdir(parents=True)
        source = record()
        source.update(status='done', metric={'accuracy': 100})
        rows = [{'status': 'PASS'}, {'status': 'UNKNOWN'}]
        source['items'][0].update(status='PASS', rules=rows, review='disagree')
        original = json.dumps(source)
        (legacy / 'runs' / 'run-1.json').write_text(original)
        (legacy / 'logs.jsonl').write_text(
            json.dumps(
                {
                    'id': 7,
                    'messages': [{'role': 'user', 'content': 'question'}, {'role': 'assistant', 'content': 'answer'}],
                }
            )
        )
        audit = {'topics': [], 'results': [{'dialogueId': 7, 'status': 'PASS', 'rules': rows}]}
        (legacy / 'discover.json').write_text(json.dumps(audit))
        report = migrate(legacy)
        self.assertEqual(report['recomputedVerdicts'], 2)
        result = storage.runs.get('run-1')
        self.assertEqual(result['items'][0]['status'], 'UNMEASURED')
        self.assertEqual(result['items'][0]['rules'], rows)
        self.assertIsNone(result['items'][0].get('review'))
        self.assertEqual(report['resetReviews'], 1)
        self.assertIsNone(result['metric']['accuracy'])
        self.assertEqual(storage.dialogues.read()[0]['id'], '7')
        analysis = storage.documents.load('discover.json')
        self.assertEqual(analysis['results'][0]['status'], 'UNMEASURED')
        self.assertEqual(analysis['summary']['unmeasured'], 1)
        self.assertEqual((legacy / 'runs' / 'run-1.json').read_text(), original)

    def test_migration_keeps_a_second_verdict_given_for_the_whole_conversation(self) -> None:
        legacy = self.path / 'legacy'
        legacy.mkdir()
        rows = [{'ruleId': 'r1', 'status': 'FAIL'}]
        second = {'model': 'second-model', 'status': 'FAIL'}
        audit = {'topics': [], 'results': [{'dialogueId': 7, 'status': 'FAIL', 'rules': rows, 'second': second}]}
        (legacy / 'discover.json').write_text(json.dumps(audit))
        migrate(legacy)
        self.assertEqual(storage.documents.load('discover.json')['results'][0]['second'], second)

    def test_the_database_lets_screens_read_while_a_job_writes(self) -> None:
        storage.documents.save('settings.json', {'x': 1})
        with sqlite3.connect(storage.db.default_database()) as connection:
            self.assertEqual(connection.execute('PRAGMA journal_mode').fetchone()[0], 'wal')

    def test_the_schema_is_set_up_once_per_database_not_on_every_connection(self) -> None:
        statements = []
        connect = sqlite3.connect

        def traced(*args, **kwargs) -> sqlite3.Connection:
            connection = connect(*args, **kwargs)
            connection.set_trace_callback(statements.append)
            return connection

        def setup(sql: str) -> bool:
            return sql.startswith(('CREATE', 'ALTER', 'PRAGMA journal_mode'))

        with patch.object(storage.db.sqlite3, 'connect', traced):
            storage.documents.save('settings.json', {'x': 1})
            self.assertTrue(any(setup(sql) for sql in statements))
            statements.clear()
            for _ in range(3):
                self.assertEqual(storage.documents.load('settings.json'), {'x': 1})
            storage.runs.create(record())
            self.assertEqual([sql for sql in statements if setup(sql)], [])
            # Another database (another agent) is set up on its first use, and only then.
            with config.using(support.changed(self.settings, data=self.path / 'other')):
                self.assertIsNone(storage.documents.load('settings.json'))
                self.assertTrue(any(setup(sql) for sql in statements))
                self.assertEqual(storage.runs.get('run-1'), None)
        self.assertEqual(storage.runs.get('run-1')['id'], 'run-1')

    def test_runs_of_an_older_database_and_every_write_keep_a_summary_without_conversations(self) -> None:
        older = record()
        older.update(status='done', items=[{'cardId': 'card-1', 'status': 'PASS', 'conversation': []}])
        with sqlite3.connect(storage.db.default_database()) as connection:
            connection.execute('CREATE TABLE runs (id TEXT PRIMARY KEY, value TEXT NOT NULL)')
            connection.execute('INSERT INTO runs (id, value) VALUES (?, ?)', ('run-1', json.dumps(older)))
        connection.close()
        summary = {key: value for key, value in older.items() if key != 'items'}
        self.assertEqual(storage.runs.summaries(), [summary | {'check': 'code'}])
        running = dict(record(), id='run-2', startedAt='2026-10-01T10:00:00+00:00')
        legacy_import.insert({}, [running])
        self.assertEqual([summary['id'] for summary in storage.runs.summaries()], ['run-2', 'run-1'])
        storage.runs.recover()
        self.assertEqual(storage.runs.summaries()[0]['status'], 'stopped')
        storage.runs.update('run-1', label='первый')
        self.assertEqual(storage.runs.summaries()[1]['label'], 'первый')
        self.assertTrue(all('items' not in summary for summary in storage.runs.summaries()))

    def test_the_export_of_an_older_database_becomes_rows_counted_without_reading_them(self) -> None:
        """Before schema 7 the export was one document: it becomes a row per conversation in its order, the document
        goes, and the export keeps a record of it (without the name of its file, which was not kept then), so that a
        legacy import never takes it for no export at all."""
        talks = [{'id': '2', 'messages': []}, {'id': '1', 'messages': []}]
        with sqlite3.connect(storage.db.default_database()) as connection:
            connection.execute('CREATE TABLE documents (name TEXT PRIMARY KEY, value TEXT NOT NULL)')
            connection.execute('INSERT INTO documents VALUES (?, ?)', ('logs.json', json.dumps(talks)))
        connection.close()
        self.assertEqual(storage.dialogues.count(), 2)
        self.assertEqual(storage.dialogues.ids(), ['2', '1'])
        self.assertEqual(storage.dialogues.read(['1']), [talks[1]])
        self.assertIsNone(storage.documents.load('logs.json'))
        self.assertEqual(storage.dialogues.meta(), {'file': None, 'updatedAt': None})
        inputs.replace_export([{'id': str(number), 'messages': []} for number in range(4)], 'Октябрь.xlsx')
        self.assertEqual(storage.dialogues.count(), 4)
        self.assertEqual(storage.dialogues.meta()['file'], 'Октябрь.xlsx')
        legacy_import.insert({'logs.json': []}, [])
        self.assertEqual(storage.dialogues.count(), 4)

    def test_changed_primary_judgment_clears_old_confirmation(self) -> None:
        source = record()
        source['items'][0].update(status='FAIL', rules=[{'status': 'FAIL'}])
        storage.runs.create(source)
        answers.on_run('run-1', 0, 'agree')
        result = storage.runs.update_item('run-1', 0, {'status': 'PASS', 'rules': [{'status': 'PASS'}]})
        self.assertIsNone(result['items'][0]['review'])
        self.assertNotIn('human', result['metric'])

    def test_changed_criterion_without_changed_aggregate_also_clears_confirmation(self) -> None:
        source = record()
        source['items'][0].update(status='FAIL', rules=[{'ruleId': 'r1', 'status': 'FAIL'}])
        storage.runs.create(source)
        answers.on_run('run-1', 0, 'agree')
        result = storage.runs.update_item('run-1', 0, {'rules': [{'ruleId': 'r2', 'status': 'FAIL'}]})
        self.assertIsNone(result['items'][0]['review'])

    def older(self, documents: dict, runs: tuple = ()) -> None:
        """A database of schema 3, when both checks shared one result (discover.json) and a deck or a run named no
        check: these documents and runs in it, before its next connection."""
        storage.documents.save('settings.json', {})
        with sqlite3.connect(storage.db.default_database()) as connection:
            for name, value in documents.items():
                connection.execute('INSERT OR REPLACE INTO documents VALUES (?, ?)', (name, json.dumps(value)))
            for run in runs:
                summary = {key: value for key, value in run.items() if key != 'items'}
                connection.execute(
                    'INSERT INTO runs VALUES (?, ?, ?)', (run['id'], json.dumps(run), json.dumps(summary))
                )
            connection.execute('PRAGMA user_version = 3')
        connection.close()

    def test_an_older_database_moves_its_tone_of_voice_result_to_its_own_place(self) -> None:
        shared = {'purpose': 'tone-of-voice', 'checkId': 'c1', 'finishedAt': '2026-10-02T10:00:00+00:00'}
        deck = {'createdAt': '2026-10-02T11:00:00+00:00', 'cards': [{'id': 'card-1', 'topic': 'Tone of voice'}]}
        played = dict(record(), status='done')
        played['items'][0].update(status='PASS', topic='Tone of voice', criteria=[{'id': 'pronouns', 'text': 'На вы'}])
        self.older({'discover.json': shared, 'cards.json': deck}, (played,))
        self.assertEqual(storage.documents.load('tone-result.json'), shared)
        self.assertIsNone(storage.documents.load('discover.json'))
        self.assertEqual(storage.documents.load('cards.json'), deck | {'check': 'tone'})
        self.assertEqual((storage.runs.get('run-1')['check'], storage.runs.summaries()[0]['check']), ('tone', 'tone'))
        # Separated once: set up again, it stays as it is.
        with sqlite3.connect(storage.db.default_database()) as connection:
            connection.execute('PRAGMA user_version = 3')
        connection.close()
        self.assertEqual(
            [storage.documents.load(name) for name in ('tone-result.json', 'discover.json', 'cards.json')],
            [shared, None, deck | {'check': 'tone'}],
        )

    def test_an_older_database_keeps_its_accuracy_result_and_labels_the_deck_built_from_it(self) -> None:
        shared = {'finishedAt': '2026-10-02T10:00:00+00:00', 'topics': [], 'results': []}
        deck = {'cards': [{'id': 'card-1', 'topic': 'Терминалы'}]}
        self.older({'discover.json': shared, 'cards.json': deck}, (dict(record(), status='done'),))
        self.assertEqual(storage.documents.load('discover.json'), shared)
        self.assertIsNone(storage.documents.load('tone-result.json'))
        self.assertEqual(storage.documents.load('cards.json'), deck | {'check': 'code'})
        self.assertEqual(storage.runs.summaries()[0]['check'], 'code')

    def test_the_legacy_import_puts_a_tone_of_voice_result_in_its_own_place(self) -> None:
        legacy = self.path / 'legacy'
        (legacy / 'runs').mkdir(parents=True)
        rows = [{'ruleId': 'pronouns', 'status': 'FAIL'}]
        shared = {
            'purpose': 'tone-of-voice',
            'topics': [{'id': 't1', 'title': 'Tone of voice', 'rules': []}],
            'results': [{'dialogueId': 7, 'status': 'FAIL', 'rules': rows}],
        }
        (legacy / 'discover.json').write_text(json.dumps(shared))
        (legacy / 'cards.json').write_text(json.dumps({'cards': [{'id': 'card-1'}]}))
        played = dict(record(), status='done')
        played['items'][0].update(status='PASS', topic='Tone of voice', rules=[{'status': 'PASS'}])
        (legacy / 'runs' / 'run-1.json').write_text(json.dumps(played))
        migrate(legacy)
        self.assertEqual(storage.documents.load('tone-result.json')['results'][0]['dialogueId'], '7')
        self.assertEqual(storage.documents.load('tone-result.json')['summary']['failed'], 1)
        self.assertIsNone(storage.documents.load('discover.json'))
        self.assertEqual(storage.documents.load('cards.json')['check'], 'tone')
        self.assertEqual((storage.runs.get('run-1')['check'], storage.runs.summaries()[0]['check']), ('tone', 'tone'))

    def test_the_legacy_export_comes_with_the_record_of_its_file(self) -> None:
        """Legacy files with the export and the record of its file bring both: the record, read first, never makes the
        export look uploaded already."""
        talk = {
            'id': 'd1',
            'messages': [{'role': 'user', 'content': 'Вопрос'}, {'role': 'assistant', 'content': 'Ответ'}],
        }
        meta = {'file': 'Сентябрь.xlsx', 'updatedAt': '2026-09-01T10:00:00+00:00'}
        self.assertEqual(
            legacy_import.insert({'logs-meta.json': meta, 'logs.json': [talk]}, []), {'documents': 2, 'runs': 0}
        )
        self.assertEqual((storage.dialogues.read(), storage.dialogues.meta()), ([talk], meta))

    def test_quoted_verdicts_judged_before_get_the_customer_s_words_their_replies_answered(self) -> None:
        """A result judged before verdicts kept the customer's words a quoted reply answered gets them when its
        database is set up again: the result in force from the export's conversations, the one kept with another
        dataset from that dataset's. Words a verdict has stay; a verdict without a quote gets none."""

        def talk(question: str) -> dict:
            return {
                'id': 'd1',
                'messages': [
                    {'role': 'user', 'content': 'Терминал не печатает чек'},
                    {'role': 'assistant', 'content': 'Проверьте бумагу в терминале.'},
                    {'role': 'user', 'content': question},
                    {'role': 'assistant', 'content': 'Нажмите на кнопку «Чат с поддержкой».'},
                ],
            }

        rows = [
            {'ruleId': 'r1', 'status': 'FAIL', 'agentQuote': 'Нажмите на кнопку «Чат с поддержкой»'},
            {'ruleId': 'r2', 'status': 'PASS', 'agentQuote': 'Проверьте бумагу', 'asked': 'как записано'},
            {'ruleId': 'r3', 'status': 'UNKNOWN', 'agentQuote': ''},
        ]
        result = {'checkId': 'c1', 'results': [{'dialogueId': 'd1', 'status': 'FAIL', 'rules': rows}]}
        first = datasets.add([talk('код авторизации где взять')], 'first.jsonl')
        storage.documents.save('tone-result.json', result)
        datasets.add([talk('а где сверка итогов')], 'second.jsonl')  # the first one's result is kept with it
        storage.documents.save('tone-result.json', result)
        with sqlite3.connect(storage.db.default_database()) as connection:
            connection.execute('PRAGMA user_version = 11')
        connection.close()

        def asked() -> list:
            return [row.get('asked') for row in storage.documents.load('tone-result.json')['results'][0]['rules']]

        self.assertEqual(asked(), ['а где сверка итогов', 'как записано', None])
        datasets.select(first['id'])
        self.assertEqual(asked(), ['код авторизации где взять', 'как записано', None])

    def test_a_dataset_takes_the_agent_version_its_newest_launch_named(self) -> None:
        """Before schema 13 the version of the agent was a launch's own; now it is the dataset's, whose answers it is.
        A database of schema 12 gives each dataset the version its newest launch named, trimmed; a launch that named
        none, the live questions' run and a dataset without launches leave it unknown."""

        def launch(launch_id: str, dataset_id: str, version: str, kind: str = 'launch') -> tuple:
            value = {'id': launch_id, 'agentVersion': version, 'inputs': {'datasetId': dataset_id}}
            return launch_id, kind, json.dumps(value), json.dumps(value)

        with sqlite3.connect(storage.db.default_database()) as connection:
            connection.execute(
                'CREATE TABLE datasets (id TEXT PRIMARY KEY, name TEXT NOT NULL, file TEXT, created_at TEXT NOT NULL, '
                'bytes INTEGER NOT NULL DEFAULT 0, archived_at TEXT, context TEXT, skipped INTEGER)'
            )
            connection.executemany(
                'INSERT INTO datasets (id, name, created_at) VALUES (?, ?, ?)',
                [(key, key, '2026-10-05T10:00:00+00:00') for key in ('first', 'second', 'third')],
            )
            connection.execute(
                'CREATE TABLE launches (id TEXT PRIMARY KEY, kind TEXT NOT NULL, summary TEXT NOT NULL, '
                'value TEXT NOT NULL)'
            )
            connection.executemany(
                'INSERT INTO launches (id, kind, summary, value) VALUES (?, ?, ?, ?)',
                [
                    launch('l1', 'first', 'v1.0'),
                    launch('l2', 'first', ' v1.1 '),
                    launch('l3', 'first', ''),
                    launch('l4', 'second', ''),
                    launch('l4-questions', 'third', 'stand-2.0', kind='questions'),
                ],
            )
            connection.execute('PRAGMA user_version = 12')
        connection.close()
        versions = {item['id']: item['agentVersion'] for item in storage.datasets.listed()}
        self.assertEqual(versions, {'first': 'v1.1', 'second': '', 'third': ''})

    def test_repeated_import_cannot_restore_invalidated_audit_or_scenarios(self) -> None:
        legacy = self.path / 'legacy'
        legacy.mkdir()
        old_log = {
            'id': '7',
            'messages': [{'role': 'user', 'content': 'question'}, {'role': 'assistant', 'content': 'old answer'}],
        }
        (legacy / 'logs.jsonl').write_text(json.dumps(old_log))
        audit = {'topics': [], 'results': [{'dialogueId': '7', 'status': 'PASS', 'rules': [{'status': 'PASS'}]}]}
        (legacy / 'discover.json').write_text(json.dumps(audit))
        (legacy / 'cards.json').write_text('{"cards":[{"id":"old"}]}')
        migrate(legacy)
        new_log = {
            'id': '7',
            'messages': [{'role': 'user', 'content': 'question'}, {'role': 'assistant', 'content': 'new answer'}],
        }
        inputs.replace_export([new_log])
        report = migrate(legacy)
        self.assertEqual(report['documents'], 0)
        self.assertEqual(storage.dialogues.read(), [new_log])
        self.assertIsNone(storage.documents.load('discover.json'))
        self.assertIsNone(storage.documents.load('cards.json'))


if __name__ == '__main__':
    unittest.main()
