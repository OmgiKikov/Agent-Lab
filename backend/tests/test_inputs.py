"""The Lab's inputs and what a new one resets (flows/inputs.py), with what a new result or new criteria reset
(flows/accuracy.publish, flows/tone.save_draft, flows/tone.publish): «Что сбрасывает что» of
docs/superpowers/specs/2026-10-03-checks-as-sections-design.md."""

import itertools
import sqlite3
import unittest
from unittest.mock import patch

import support

from lab import storage
from lab.flows import accuracy, answers, inputs, tone


def record() -> dict:
    return {
        'id': 'run-1',
        'startedAt': '2026-09-30T10:00:00+00:00',
        'status': 'running',
        'items': [{'cardId': 'card-1', 'status': 'RUNNING', 'conversation': [], 'review': None}],
    }


def published(snapshot: dict) -> tuple[dict, dict]:
    """A saved check of tone of voice as tone.publish takes it: the result and its record."""
    return snapshot['result'], snapshot


class InputsTests(unittest.TestCase):
    def setUp(self) -> None:
        support.lab(self)

    def test_input_replacement_invalidates_derived_documents_and_preserves_runs(self) -> None:
        storage.runs.create(record())
        answers.on_run('run-1', 0, 'disagree')
        storage.documents.save('discover.json', {'results': ['old']})
        storage.documents.save('cards.json', {'cards': ['old']})
        inputs.replace_sources([{'id': 's1', 'content': 'new'}])
        self.assertEqual(storage.documents.load('sources.json')[0]['content'], 'new')
        self.assertIsNone(storage.documents.load('discover.json'))
        self.assertIsNone(storage.documents.load('cards.json'))
        self.assertEqual(storage.runs.get('run-1')['items'][0]['review'], 'disagree')

    def test_new_code_invalidates_its_audit_but_not_the_criteria_of_an_unchanged_tone_policy(self) -> None:
        policy = {'id': 'tone-of-voice', 'kind': 'tone-of-voice', 'content': 'Обращайтесь на вы.', 'sha256': 'p1'}
        storage.documents.save('sources.json', [{'id': 's1', 'kind': 'prompt', 'content': 'old'}, policy])
        storage.documents.save('tone-of-voice-criteria.json', {'revision': 'r1'})
        storage.documents.save('discover.json', {'results': ['by the code']})
        inputs.replace_sources([{'id': 's1', 'kind': 'prompt', 'content': 'new'}, policy])
        self.assertIsNone(storage.documents.load('discover.json'))
        self.assertEqual(storage.documents.load('tone-of-voice-criteria.json'), {'revision': 'r1'})
        inputs.replace_sources([{'id': 's1', 'kind': 'prompt', 'content': 'new'}])
        self.assertIsNone(storage.documents.load('tone-of-voice-criteria.json'))

    def test_what_resets_what(self) -> None:
        """The table «Что сбрасывает что» of docs/superpowers/specs/2026-10-03-checks-as-sections-design.md: what each
        event leaves of the tone-of-voice criteria (D), the results of tone of voice (T) and Точность (C), and the
        deck (K) built from tone of voice, from Точность, or one that names no check."""
        policy = {'id': 'tone-of-voice', 'kind': 'tone-of-voice', 'content': 'Обращайтесь на вы.', 'sha256': 'p1'}
        code = {'id': 's1', 'kind': 'prompt', 'content': 'Называй срок.', 'sha256': 'c1'}
        names = {'D': 'tone-of-voice-criteria.json', 'T': 'tone-result.json', 'C': 'discover.json', 'K': 'cards.json'}
        checked = (  # every tone-of-voice check is kept in the history under its own id
            {'check': {'id': f'check-{n}', 'finishedAt': str(n)}, 'result': {'purpose': 'tone-of-voice', 'results': []}}
            for n in itertools.count()
        )
        events = {
            'new export': lambda: inputs.replace_export([{'id': 'd2'}]),
            'communication rules changed': lambda: inputs.replace_sources(
                [code, policy | {'content': 'Обращайтесь на ты.', 'sha256': 'p2'}]
            ),
            'code changed': lambda: inputs.replace_sources([code | {'content': 'Срок.', 'sha256': 'c2'}, policy]),
            'code read again unchanged': lambda: inputs.replace_sources([code, policy]),
            # An import added above the prompt: the same text found a line lower.
            'code read again, a prompt moved down a line': lambda: inputs.replace_sources(
                [code | {'name': 'agent.py:2', 'origin': 'agent.py:2'}, policy]
            ),
            'communication rules saved under another name': lambda: inputs.replace_sources(
                [code, policy | {'name': 'ToV, версия 2.docx', 'origin': 'ToV, версия 2.docx'}]
            ),
            'new tone-of-voice criteria': lambda: tone.save_draft({'revision': 'r2'}),
            'tone-of-voice criteria saved unchanged': lambda: tone.save_draft({'revision': 'r1'}),
            'new tone-of-voice result': lambda: tone.publish(*published(next(checked))),
            'new accuracy result with new criteria': lambda: accuracy.publish({'topics': []}, new_criteria=True),
            'new accuracy result with the same criteria': lambda: accuracy.publish({'topics': []}, new_criteria=False),
        }
        kept = {  # deck built from: tone, code, no check named
            'new export': ('D', 'D', 'D'),
            'communication rules changed': ('C', 'CK', 'C'),
            'code changed': ('DTK', 'DT', 'DT'),
            'code read again unchanged': ('DTCK', 'DTCK', 'DTCK'),
            'code read again, a prompt moved down a line': ('DTCK', 'DTCK', 'DTCK'),
            'communication rules saved under another name': ('DTCK', 'DTCK', 'DTCK'),
            'new tone-of-voice criteria': ('DTC', 'DTCK', 'DTC'),
            'tone-of-voice criteria saved unchanged': ('DTCK', 'DTCK', 'DTCK'),
            'new tone-of-voice result': ('DTC', 'DTCK', 'DTC'),
            'new accuracy result with new criteria': ('DTCK', 'DTC', 'DTC'),
            'new accuracy result with the same criteria': ('DTCK', 'DTCK', 'DTCK'),
        }
        for event, happen in events.items():
            for deck, expected in zip(('tone', 'code', None), kept[event], strict=True):
                with self.subTest(event=event, deck=deck):
                    storage.documents.save('sources.json', [code, policy])
                    storage.documents.save(names['D'], {'revision': 'r1'})
                    storage.documents.save(names['T'], {'purpose': 'tone-of-voice', 'results': []})
                    storage.documents.save(names['C'], {'topics': [], 'results': []})
                    storage.documents.save(names['K'], {'check': deck, 'cards': [{'id': 'card-1'}]})
                    happen()
                    left = ''.join(key for key, name in names.items() if storage.documents.load(name) is not None)
                    self.assertEqual(left, expected)

    def test_the_export_and_its_file_name_are_one_write(self) -> None:
        """A failure between two writes would leave the new export under the previous file's name, and the history of
        the next check would name the wrong file: nothing of a replacement that failed is written."""
        talk = {'messages': [{'role': 'user', 'content': 'Вопрос'}, {'role': 'assistant', 'content': 'Ответ'}]}
        self.assertEqual(inputs.replace_export([{'id': 'old', **talk}], 'Сентябрь.xlsx'), 1)
        storage.documents.save('discover.json', {'results': ['stays']})
        real = storage.documents.put

        def put(connection: sqlite3.Connection, name: str, value: object) -> None:
            if name == storage.dialogues.META:
                raise sqlite3.OperationalError('disk I/O error')
            real(connection, name, value)

        with patch.object(storage.documents, 'put', side_effect=put), self.assertRaises(sqlite3.OperationalError):
            inputs.replace_export([{'id': 'new', **talk}], 'Октябрь.xlsx')
        self.assertEqual(storage.dialogues.ids(), ['old'])
        self.assertEqual(storage.dialogues.meta()['file'], 'Сентябрь.xlsx')
        self.assertEqual(storage.documents.load('discover.json'), {'results': ['stays']})


if __name__ == '__main__':
    unittest.main()
