import json
import sqlite3
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

from lab import store
from lab.migrate import migrate


def record() -> dict:
    return {
        'id': 'run-1',
        'startedAt': '2026-09-30T10:00:00+00:00',
        'status': 'running',
        'items': [{'cardId': 'card-1', 'status': 'RUNNING', 'conversation': [], 'review': None}],
    }


class StoreTests(unittest.TestCase):
    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name)
        self.database = patch.object(store, 'DB', self.path / 'lab.sqlite3')
        self.database.start()
        self.addCleanup(self.database.stop)

    def test_producer_patch_preserves_review_and_recomputes_metric(self) -> None:
        stale = record()
        stale['items'][0].update(status='PASS', rules=[{'status': 'PASS'}])
        store.create_run(stale)
        store.set_review('run-1', 0, 'disagree')
        stale['items'][0].update(stage='finished')
        result = store.update_item('run-1', 0, stale['items'][0])
        self.assertEqual(result['items'][0]['review'], 'disagree')
        self.assertEqual(result['metric']['accuracy'], 100)
        self.assertEqual(result['metric']['human'], {'reviewed': 1, 'agree': 0})
        self.assertEqual(result['revision'], 3)
        self.assertTrue(result['updatedAt'])

    def test_concurrent_review_and_progress_do_not_overwrite_each_other(self) -> None:
        source = record()
        source['items'][0]['status'] = 'PASS'
        store.create_run(source)

        def progress() -> None:
            for index in range(12):
                store.update_item('run-1', 0, {'stage': str(index), 'status': 'PASS', 'review': None})

        def review() -> None:
            for _ in range(12):
                store.set_review('run-1', 0, 'agree')

        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(progress), pool.submit(review)]
            for future in futures:
                future.result()
        result = store.run('run-1')
        self.assertEqual(result['items'][0]['review'], 'agree')
        self.assertEqual(result['items'][0]['stage'], '11')
        self.assertEqual(result['revision'], 25)

    def test_full_run_replacement_is_not_an_update_operation(self) -> None:
        store.create_run(record())
        with self.assertRaises(ValueError):
            store.update_run('run-1', items=[])
        self.assertEqual(len(store.run('run-1')['items']), 1)

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
        self.assertIsNone(store.run('run-1'))
        self.assertEqual(migrate(legacy), {'documents': 2, 'runs': 1, 'recomputedVerdicts': 0, 'resetReviews': 0})
        self.assertEqual(store.load('logs.json')[0]['id'], 'dialogue-1')
        self.assertEqual(store.run('run-1')['items'][0]['review'], 'disagree')
        store.set_review('run-1', 0, 'agree')
        self.assertEqual(migrate(legacy), {'documents': 0, 'runs': 0, 'recomputedVerdicts': 0, 'resetReviews': 0})
        self.assertEqual(store.run('run-1')['items'][0]['review'], 'agree')
        self.assertEqual(run_file.read_text(), original)

    def test_interrupted_legacy_run_gets_terminal_status(self) -> None:
        legacy = self.path / 'legacy'
        (legacy / 'runs').mkdir(parents=True)
        (legacy / 'runs' / 'run-1.json').write_text(json.dumps(record()))
        migrate(legacy)
        result = store.run('run-1')
        self.assertEqual(result['status'], 'stopped')
        self.assertEqual(result['items'][0]['status'], 'UNMEASURED')
        self.assertTrue(result['finishedAt'])

    def test_input_replacement_invalidates_derived_documents_and_preserves_runs(self) -> None:
        store.create_run(record())
        store.set_review('run-1', 0, 'disagree')
        store.save('discover.json', {'results': ['old']})
        store.save('cards.json', {'cards': ['old']})
        store.replace_inputs('sources.json', [{'id': 's1', 'content': 'new'}])
        self.assertEqual(store.load('sources.json')[0]['content'], 'new')
        self.assertIsNone(store.load('discover.json'))
        self.assertIsNone(store.load('cards.json'))
        self.assertEqual(store.run('run-1')['items'][0]['review'], 'disagree')

    def test_new_code_invalidates_its_audit_but_not_the_criteria_of_an_unchanged_tone_policy(self) -> None:
        policy = {'id': 'tone-of-voice', 'kind': 'tone-of-voice', 'content': 'Обращайтесь на вы.', 'sha256': 'p1'}
        store.save('sources.json', [{'id': 's1', 'kind': 'prompt', 'content': 'old'}, policy])
        store.save('tone-of-voice-criteria.json', {'revision': 'r1'})
        store.save('discover.json', {'results': ['by the code']})
        store.replace_inputs('sources.json', [{'id': 's1', 'kind': 'prompt', 'content': 'new'}, policy])
        self.assertIsNone(store.load('discover.json'))
        self.assertEqual(store.load('tone-of-voice-criteria.json'), {'revision': 'r1'})
        store.replace_inputs('sources.json', [{'id': 's1', 'kind': 'prompt', 'content': 'new'}])
        self.assertIsNone(store.load('tone-of-voice-criteria.json'))

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
        result = store.run('run-1')
        self.assertEqual(result['items'][0]['status'], 'UNMEASURED')
        self.assertEqual(result['items'][0]['rules'], rows)
        self.assertIsNone(result['items'][0]['review'])
        self.assertEqual(report['resetReviews'], 1)
        self.assertIsNone(result['metric']['accuracy'])
        self.assertEqual(store.load('logs.json')[0]['id'], '7')
        analysis = store.load('discover.json')
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
        self.assertEqual(store.load('discover.json')['results'][0]['second'], second)

    def test_the_database_lets_screens_read_while_a_job_writes(self) -> None:
        store.save('settings.json', {'x': 1})
        with sqlite3.connect(store.DB) as connection:
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

        with patch.object(store.sqlite3, 'connect', traced):
            store.save('settings.json', {'x': 1})
            self.assertTrue(any(setup(sql) for sql in statements))
            statements.clear()
            for _ in range(3):
                self.assertEqual(store.load('settings.json'), {'x': 1})
            store.create_run(record())
            self.assertEqual([sql for sql in statements if setup(sql)], [])
            # Another database (another agent) is set up on its first use, and only then.
            with patch.object(store, 'DB', self.path / 'other' / 'lab.sqlite3'):
                self.assertIsNone(store.load('settings.json'))
                self.assertTrue(any(setup(sql) for sql in statements))
                self.assertEqual(store.run('run-1'), None)
        self.assertEqual(store.run('run-1')['id'], 'run-1')

    def test_runs_of_an_older_database_and_every_write_keep_a_summary_without_conversations(self) -> None:
        older = record()
        older.update(status='done', items=[{'cardId': 'card-1', 'status': 'PASS', 'conversation': []}])
        with sqlite3.connect(store.DB) as connection:
            connection.execute('CREATE TABLE runs (id TEXT PRIMARY KEY, value TEXT NOT NULL)')
            connection.execute('INSERT INTO runs (id, value) VALUES (?, ?)', ('run-1', json.dumps(older)))
        connection.close()
        summary = {key: value for key, value in older.items() if key != 'items'}
        self.assertEqual(store.run_summaries(), [summary | {'check': 'code'}])
        running = dict(record(), id='run-2', startedAt='2026-10-01T10:00:00+00:00')
        store.import_legacy({}, [running])
        self.assertEqual([summary['id'] for summary in store.run_summaries()], ['run-2', 'run-1'])
        store.recover_runs()
        self.assertEqual(store.run_summaries()[0]['status'], 'stopped')
        store.update_run('run-1', label='первый')
        self.assertEqual(store.run_summaries()[1]['label'], 'первый')
        self.assertTrue(all('items' not in summary for summary in store.run_summaries()))

    def test_the_number_of_dialogues_is_kept_beside_them_by_every_write(self) -> None:
        with sqlite3.connect(store.DB) as connection:
            connection.execute('CREATE TABLE documents (name TEXT PRIMARY KEY, value TEXT NOT NULL)')
            connection.execute('INSERT INTO documents VALUES (?, ?)', ('logs.json', json.dumps([{'id': '1'}] * 2)))
        connection.close()
        self.assertEqual(store.length('logs.json'), 2)
        store.save('logs.json', [{'id': '1'}])
        self.assertEqual(store.length('logs.json'), 1)
        store.replace_inputs('logs.json', [{'id': str(number)} for number in range(4)])
        self.assertEqual(store.length('logs.json'), 4)
        store.import_legacy({'logs.json': []}, [])
        self.assertEqual(store.length('logs.json'), 4)
        with self.assertRaises(ValueError):
            store.length('discover.json')
        # A SQLite without JSON functions keeps no number: the dialogues are read and counted.
        with (
            patch.object(store, 'DB', self.path / 'plain' / 'lab.sqlite3'),
            patch.object(store, '_json_functions', return_value=False),
        ):
            self.assertEqual(store.length('logs.json'), 0)
            store.save('logs.json', [{'id': '1'}] * 3)
            self.assertEqual(store.length('logs.json'), 3)

    def test_changed_primary_judgment_clears_old_confirmation(self) -> None:
        source = record()
        source['items'][0].update(status='FAIL', rules=[{'status': 'FAIL'}])
        store.create_run(source)
        store.set_review('run-1', 0, 'agree')
        result = store.update_item('run-1', 0, {'status': 'PASS', 'rules': [{'status': 'PASS'}]})
        self.assertIsNone(result['items'][0]['review'])
        self.assertNotIn('human', result['metric'])

    def test_changed_criterion_without_changed_aggregate_also_clears_confirmation(self) -> None:
        source = record()
        source['items'][0].update(status='FAIL', rules=[{'ruleId': 'r1', 'status': 'FAIL'}])
        store.create_run(source)
        store.set_review('run-1', 0, 'agree')
        result = store.update_item('run-1', 0, {'rules': [{'ruleId': 'r2', 'status': 'FAIL'}]})
        self.assertIsNone(result['items'][0]['review'])

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
        store.replace_inputs('logs.json', [new_log])
        report = migrate(legacy)
        self.assertEqual(report['documents'], 0)
        self.assertEqual(store.load('logs.json'), [new_log])
        self.assertIsNone(store.load('discover.json'))
        self.assertIsNone(store.load('cards.json'))


if __name__ == '__main__':
    unittest.main()
