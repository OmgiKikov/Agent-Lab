"""The answers people give on the judge's verdicts are rows of their own, a journal (storage.reviews): each one with the
verdict it was given on and who gave it, the latest one on a case is the answer. A result, a saved check and a run keep
the verdicts only. An older database brings its answers out of them when it is opened (schema 7)."""

import json
import sqlite3
import unittest

import support

from lab import storage
from lab.domain.answers import counts
from lab.flows import accuracy, answers
from lab.flows import checks as results_of

# The tables of a database the Lab left before schema 7.
SCHEMA_6 = """
CREATE TABLE documents (name TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE runs (id TEXT PRIMARY KEY, value TEXT NOT NULL, summary TEXT);
CREATE TABLE tone_checks (id TEXT PRIMARY KEY, summary TEXT NOT NULL, value TEXT NOT NULL);
CREATE TABLE code_checks (id TEXT PRIMARY KEY, summary TEXT NOT NULL, value TEXT NOT NULL);
CREATE TABLE tone_check_reviews (check_id TEXT NOT NULL, dialogue_id TEXT NOT NULL, rule_id TEXT NOT NULL,
    decision TEXT, updated_at TEXT NOT NULL, PRIMARY KEY (check_id, dialogue_id, rule_id));
CREATE TABLE code_check_reviews (check_id TEXT NOT NULL, dialogue_id TEXT NOT NULL, rule_id TEXT NOT NULL,
    decision TEXT, updated_at TEXT NOT NULL, PRIMARY KEY (check_id, dialogue_id, rule_id));
CREATE TABLE lengths (name TEXT PRIMARY KEY, length INTEGER NOT NULL);
"""


def verdict(rule_id: str, status: str, quote: str = '') -> dict:
    return {'ruleId': rule_id, 'status': status, 'reason': 'Причина', 'agentQuote': quote}


def result(check_id: str, finished_at: str, review: str | None = None) -> dict:
    """A check's result with one error in one conversation, and the answer on it when one is given."""
    row = verdict('r1', 'FAIL', 'звоните')
    if review:
        row['review'] = review
    return {
        'checkId': check_id,
        'finishedAt': finished_at,
        'sampled': 1,
        'model': 'model-a',
        'summary': {'measured': 1, 'passed': 0, 'failed': 1, 'unmeasured': 0},
        'topics': [{'id': 't1', 'title': 'Тема', 'rules': [{'id': 'r1', 'text': 'Критерий'}]}],
        'results': [{'dialogueId': 'd1', 'topicId': 't1', 'status': 'FAIL', 'judgeVersion': 'v1', 'rules': [row]}],
    }


def played(review: str | None = None, whole: str | None = None) -> dict:
    """A run with one played conversation, an error in it, and the answers on it when they are given."""
    row = verdict('r1', 'FAIL', 'звоните')
    if review:
        row['review'] = review
    item = {'cardId': 'card-1', 'status': 'FAIL', 'judgeVersion': 'v1', 'rules': [row]}
    if whole:
        item['review'] = whole
    return {'id': 'run-1', 'startedAt': 'at-3', 'updatedAt': 'at-4', 'status': 'done', 'items': [item]}


class AnswerJournalTests(unittest.TestCase):
    def setUp(self) -> None:
        support.lab(self)

    def test_every_answer_is_kept_with_the_verdict_it_was_given_on_and_the_latest_one_counts(self) -> None:
        storage.documents.save('discover.json', result('c1', 'at-1'))
        answers.on_log('code', 'd1', 'r1', 'agree', 'at-1', 'FAIL', None)
        answers.on_log('code', 'd1', 'r1', 'disagree', 'at-1', 'FAIL', 'agree')
        answers.on_log('code', 'd1', 'r1', None, 'at-1', 'FAIL', 'disagree')
        rows = storage.reviews.journal('log')
        self.assertEqual([row['decision'] for row in rows], ['agree', 'disagree', None])
        self.assertEqual(
            {(row['recordId'], row['status'], row['quote'], row['version'], row['author']) for row in rows},
            {('c1', 'FAIL', 'звоните', 'v1', 'person')},
        )
        self.assertIsNone(results_of.current('code')['results'][0]['rules'][0]['review'])
        # The result keeps the verdicts only, and an answer on one the person did not see is refused.
        self.assertNotIn('review', storage.documents.load('discover.json')['results'][0]['rules'][0])
        with self.assertRaisesRegex(ValueError, 'уже ответили'):
            answers.on_log('code', 'd1', 'r1', 'agree', 'at-1', 'FAIL', 'agree')

    def test_a_verdict_judged_again_otherwise_takes_its_answer_back_in_the_labs_name(self) -> None:
        storage.runs.create(played())
        answers.on_run('run-1', 0, 'agree', 'r1', 'FAIL', None)
        self.assertEqual(storage.runs.get('run-1')['metric']['human'], {'reviewed': 1, 'agree': 1})
        changed = {'status': 'PASS', 'rules': [verdict('r1', 'PASS')], 'judgeVersion': 'v2'}
        storage.runs.update_items('run-1', {0: changed})
        self.assertEqual(
            [(row['decision'], row['author'], row['status'], row['version']) for row in storage.reviews.journal('sim')],
            [('agree', 'person', 'FAIL', 'v1'), (None, 'lab', 'PASS', 'v2')],
        )
        run = storage.runs.get('run-1')
        self.assertIsNone(run['items'][0]['rules'][0]['review'])
        self.assertNotIn('human', run['metric'])
        # Judged as before once more: a person's answer is not given back by itself.
        storage.runs.update_items('run-1', {0: {'status': 'FAIL', 'rules': [verdict('r1', 'FAIL', 'звоните')]}})
        self.assertIsNone(storage.runs.get('run-1')['items'][0]['rules'][0]['review'])

    def test_an_answer_carried_to_a_new_check_is_written_by_the_lab(self) -> None:
        accuracy.publish(result('c2', 'at-2', review='agree'), None, new_criteria=False)
        self.assertEqual(
            [(row['recordId'], row['decision'], row['author'], row['at']) for row in storage.reviews.journal()],
            [('c2', 'agree', 'lab', 'at-2')],
        )
        self.assertNotIn('review', storage.documents.load('discover.json')['results'][0]['rules'][0])
        self.assertEqual(results_of.current('code')['results'][0]['rules'][0]['review'], 'agree')

    def test_the_stamp_of_answers_moves_with_every_answer_on_any_record(self) -> None:
        storage.documents.save('discover.json', result('c1', 'at-1'))
        storage.runs.create(played())
        stamps = [storage.reviews.stamp()]
        answers.on_log('code', 'd1', 'r1', 'agree')
        stamps.append(storage.reviews.stamp())
        answers.on_run('run-1', 0, 'disagree', 'r1')
        stamps.append(storage.reviews.stamp())
        answers.on_log('code', 'd1', 'r1', None)
        stamps.append(storage.reviews.stamp())
        self.assertEqual(len(set(stamps)), 4)


class CountTests(unittest.TestCase):
    def test_a_result_is_counted_with_peoples_answers_taken_in(self) -> None:
        """An error taken back leaves its conversation without one, a miss found gives one, and a conversation the
        check could not check stays out of the count whatever was answered on it."""
        result = {
            'results': [
                {'status': 'FAIL', 'rules': [dict(verdict('r1', 'FAIL'), review='disagree'), verdict('r2', 'PASS')]},
                {'status': 'FAIL', 'rules': [dict(verdict('r1', 'FAIL'), review='agree')]},
                {'status': 'PASS', 'rules': [dict(verdict('r1', 'PASS'), review='disagree')]},
                {'status': 'UNMEASURED', 'rules': [dict(verdict('r1', 'FAIL'), review='agree')]},
            ]
        }
        self.assertEqual(
            counts(result),
            {
                'measured': 3,
                'failed': 2,
                'counted': 2,
                'errors': 3,
                'confirmed': 2,
                'removed': 1,
                'clean': 1,
                'missed': 1,
            },
        )


class OlderDatabaseTests(unittest.TestCase):
    def setUp(self) -> None:
        support.lab(self)

    def schema_6(self) -> None:
        """A database as the Lab left it before schema 7: the export one document, a table of saved checks per check
        with a table of answers beside each, the answers on the current results and on runs inside them."""
        tone_record = {'check': {'id': 't1', 'finishedAt': 'at-1'}, 'result': result('t1', 'at-1', 'agree')}
        code_record = {'check': {'id': 'c1', 'finishedAt': 'at-2'}, 'result': result('c1', 'at-2')}
        run = played(review='disagree', whole='agree')
        run['metric'] = {'total': 1, 'human': {'reviewed': 1, 'agree': 0}}
        path = storage.db.default_database()
        path.parent.mkdir(parents=True, exist_ok=True)
        with sqlite3.connect(path) as connection:
            connection.executescript(SCHEMA_6)
            documents = {
                'logs.json': [{'id': 'd1', 'messages': []}, {'id': 'd2', 'messages': []}],
                'logs-meta.json': {'file': 'Сентябрь.xlsx', 'updatedAt': 'at-0'},
                # A person changed the answer carried to the check of tone of voice, and answered on Точность's.
                'tone-result.json': result('t1', 'at-1', 'disagree'),
                'discover.json': result('c1', 'at-2', 'agree'),
            }
            for name, value in documents.items():
                connection.execute('INSERT INTO documents VALUES (?, ?)', (name, json.dumps(value)))
            for table, record in (('tone_checks', tone_record), ('code_checks', code_record)):
                connection.execute(
                    f'INSERT INTO {table} VALUES (?, ?, ?)',
                    (record['check']['id'], json.dumps(record['check']), json.dumps(record)),
                )
            reviews = [
                ('tone_check_reviews', 't1', 'agree', 'at-1'),  # the carried answer, written when the check was saved
                ('tone_check_reviews', 't1', 'disagree', 'at-5'),
                ('code_check_reviews', 'c1', 'agree', 'at-6'),
            ]
            for table, check_id, decision, at in reviews:
                connection.execute(
                    f'INSERT OR REPLACE INTO {table} VALUES (?, ?, ?, ?, ?)', (check_id, 'd1', 'r1', decision, at)
                )
            summary = {key: value for key, value in run.items() if key != 'items'}
            connection.execute('INSERT INTO runs VALUES (?, ?, ?)', ('run-1', json.dumps(run), json.dumps(summary)))
            connection.execute('INSERT INTO lengths VALUES (?, ?)', ('logs.json', 2))
            connection.execute('PRAGMA user_version = 6')
        connection.close()

    def test_the_answers_an_older_lab_kept_are_credited_to_whoever_gave_them(self) -> None:
        """A record of Точность kept the answers the Lab carried to it, except the first one, which an older Lab made
        of a result from before the history of checks with the answers people had given on it. A row of the old tables
        is a person's click, also one that repeats the answer shown, except the copy of a carried answer a check of
        tone of voice wrote with itself."""
        first = {'id': 'c1', 'finishedAt': 'at-1', 'comparison': {'kind': 'first', 'previousId': None}}
        second = {'id': 'c2', 'finishedAt': 'at-2', 'comparison': {'kind': 'same-data', 'previousId': 'c1'}}
        tone = {'id': 't1', 'finishedAt': 'at-3', 'comparison': {'kind': 'first', 'previousId': None}}
        records = [
            ('code_checks', {'check': first, 'result': result('c1', 'at-1', 'disagree')}),
            ('code_checks', {'check': second, 'result': result('c2', 'at-2', 'disagree')}),
            ('tone_checks', {'check': tone, 'result': result('t1', 'at-3', 'agree')}),
        ]
        path = storage.db.default_database()
        path.parent.mkdir(parents=True, exist_ok=True)
        with sqlite3.connect(path) as connection:
            connection.executescript(SCHEMA_6)
            for table, record in records:
                values = (record['check']['id'], json.dumps(record['check']), json.dumps(record))
                connection.execute(f'INSERT INTO {table} VALUES (?, ?, ?)', values)
            rows = [
                ('code_check_reviews', 'c2', 'disagree', 'at-9'),  # the person said again what the Lab carried
                ('tone_check_reviews', 't1', 'agree', 'at-3'),  # the copy written with the check
            ]
            for table, check_id, decision, at in rows:
                connection.execute(f'INSERT INTO {table} VALUES (?, ?, ?, ?, ?)', (check_id, 'd1', 'r1', decision, at))
            connection.execute('PRAGMA user_version = 6')
        connection.close()
        self.assertEqual(
            [(row['recordId'], row['decision'], row['author']) for row in storage.reviews.journal('log')],
            [
                ('t1', 'agree', 'lab'),
                ('c1', 'disagree', 'person'),
                ('c2', 'disagree', 'lab'),
                ('c2', 'disagree', 'person'),
            ],
        )

    def test_an_older_database_keeps_what_its_screens_showed_with_answers_as_rows(self) -> None:
        self.schema_6()
        # The export: rows in its order, its file still named.
        self.assertEqual(storage.dialogues.ids(), ['d1', 'd2'])
        self.assertEqual(storage.dialogues.meta()['file'], 'Сентябрь.xlsx')
        self.assertIsNone(storage.documents.load('logs.json'))
        # The saved checks: one table, their records keep the verdicts only.
        self.assertEqual([line['id'] for line in storage.history.lines('tone')], ['t1'])
        self.assertEqual([line['id'] for line in storage.history.lines('code')], ['c1'])
        self.assertNotIn('review', storage.history.get('tone', 't1')['result']['results'][0]['rules'][0])
        # The answers the screens showed, now rows: the carried one by the Lab, then the person's change.
        self.assertEqual(results_of.current('tone')['results'][0]['rules'][0]['review'], 'disagree')
        self.assertEqual(results_of.current('code')['results'][0]['rules'][0]['review'], 'agree')
        self.assertEqual(
            [(row['recordId'], row['decision'], row['author']) for row in storage.reviews.journal('log')],
            [('t1', 'agree', 'lab'), ('t1', 'disagree', 'person'), ('c1', 'agree', 'person')],
        )
        self.assertEqual(
            {(row['status'], row['quote'], row['version']) for row in storage.reviews.journal('log')},
            {('FAIL', 'звоните', 'v1')},
        )
        self.assertNotIn('review', storage.documents.load('tone-result.json')['results'][0]['rules'][0])
        # A run: its answers laid on it when it is read, and counted then.
        run = storage.runs.get('run-1')
        self.assertEqual((run['items'][0]['rules'][0]['review'], run['items'][0]['review']), ('disagree', 'agree'))
        self.assertEqual(run['metric']['human'], {'reviewed': 1, 'agree': 0})
        self.assertEqual(
            [(row['ruleId'], row['decision'], row['quote'], row['at']) for row in storage.reviews.journal('sim')],
            [('r1', 'disagree', 'звоните', 'at-4'), ('', 'agree', None, 'at-4')],
        )
        self.assertEqual(storage.runs.summaries()[0]['metric']['human'], {'reviewed': 1, 'agree': 0})
        with sqlite3.connect(storage.db.default_database()) as connection:
            stored = connection.execute("SELECT value FROM runs WHERE id = 'run-1'").fetchone()[0]
            tables = {name for (name,) in connection.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
            version = connection.execute('PRAGMA user_version').fetchone()[0]
        connection.close()
        self.assertNotIn('review', stored)
        self.assertNotIn('human', stored)
        old = {'tone_checks', 'code_checks', 'tone_check_reviews', 'code_check_reviews', 'lengths'}
        self.assertEqual(tables & old, set())
        self.assertEqual(version, 7)


if __name__ == '__main__':
    unittest.main()
