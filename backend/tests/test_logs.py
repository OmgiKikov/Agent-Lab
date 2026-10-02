import io
import json
import unittest
from unittest.mock import patch

from openpyxl import Workbook

from lab import logs


def excel(text, order, dialogue_id='d1', include_order=True):
    workbook = Workbook()
    sheet = workbook.active
    sheet.title = logs.SHEET
    sheet.append([logs.ID, logs.TEXT, *([logs.ORDER] if include_order else [])])
    sheet.append([dialogue_id, text, *([order] if include_order else [])])
    stream = io.BytesIO()
    workbook.save(stream)
    workbook.close()
    return stream.getvalue()


PAIR = 'CLIENT Не знаю номер\nAGENT Назовите номер терминала\n'


class LogImportTests(unittest.TestCase):
    def test_malformed_excel_is_a_validation_error(self):
        with self.assertRaisesRegex(ValueError, 'Не удалось прочитать файл Excel'):
            logs.prepare('broken.xlsx', b'this is not an Excel archive')

    def test_count_confirmed_double_export_preserves_actual_repeated_exchanges(self):
        dialogues = logs.prepare('export.xlsx', excel(PAIR * 4, '[1, 2, 3, 4]'))
        self.assertEqual(len(dialogues[0]['messages']), 4)
        self.assertEqual(dialogues[0]['messages'][:2], dialogues[0]['messages'][2:])

    def test_already_single_export_preserves_real_repeat(self):
        dialogues = logs.prepare('export.xlsx', excel(PAIR * 2, '[1, 2, 3, 4]'))
        self.assertEqual(len(dialogues[0]['messages']), 4)

    def test_multiple_different_exchanges_keep_their_original_order(self):
        other = 'CLIENT Дайте инструкцию\nAGENT Откройте настройки\n'
        dialogues = logs.prepare('export.xlsx', excel(PAIR * 4 + other * 2, '[1, 2, 3, 4, 5, 6]'))
        messages = dialogues[0]['messages']
        self.assertEqual(len(messages), 6)
        self.assertEqual(messages[-2]['content'], 'Дайте инструкцию')

    def test_partial_duplication_settled_by_the_count_is_collapsed(self):
        other = 'CLIENT Дайте инструкцию\nAGENT Откройте настройки.\n'
        dialogue = logs.prepare('export.xlsx', excel(PAIR * 2 + other + other, '[1, 2, 3, 4]'))[0]
        self.assertEqual([m['content'] for m in dialogue['messages']][::2], ['Не знаю номер', 'Дайте инструкцию'])
        self.assertEqual(dialogue['meta']['import'], {'status': 'collapsed', 'textMessages': 8, 'kept': [0, 1, 4, 5]})

    def test_ambiguous_conversation_is_quarantined_and_the_rest_imported(self):
        other = 'CLIENT Дайте инструкцию\nAGENT Откройте настройки\n'
        workbook = Workbook()
        sheet = workbook.active
        sheet.title = logs.SHEET
        sheet.append([logs.ID, logs.TEXT, logs.ORDER])
        sheet.append(['d1', PAIR * 2 + other * 2, '[1, 2, 3, 4, 5, 6]'])
        sheet.append(['d2', PAIR, '[1, 2]'])
        stream = io.BytesIO()
        workbook.save(stream)
        upload = logs.read_upload('export.xlsx', stream.getvalue())
        self.assertEqual([d['id'] for d in upload.dialogues], ['d2'])
        self.assertEqual(upload.report()['quarantined'][0]['id'], 'd1')
        self.assertIn('несколько прочтений', upload.report()['quarantined'][0]['reason'])

    def test_service_columns_are_kept_and_customer_ids_only_as_a_pseudonym(self):
        workbook = Workbook()
        sheet = workbook.active
        sheet.title = logs.SHEET
        sheet.append([logs.ID, logs.TEXT, logs.ORDER, 'Канал', 'agentCode', 'Статус код 202_5', 'epkId'])
        sheet.append(['d', PAIR, '[1, 2]', "['WEB']", "['ACQUIRING_AGENT']", "['agent-ckr-pa-acquiring-COMMON']", '42'])
        stream = io.BytesIO()
        workbook.save(stream)
        meta = logs.prepare('export.xlsx', stream.getvalue())[0]['meta']
        self.assertEqual(
            (meta['channel'], meta['agents'], meta['acquiringStatuses']), ('WEB', ['ACQUIRING_AGENT'], ['202_5'])
        )
        self.assertNotIn('42', json.dumps(meta))

    def test_missing_or_invalid_order_never_guesses(self):
        for order in (None, 'not JSON', '{}', '[]'):
            with self.subTest(order=order), self.assertRaises(ValueError):
                logs.prepare('export.xlsx', excel(PAIR * 2, order))
        with self.assertRaises(ValueError):
            logs.prepare('export.xlsx', excel(PAIR, None, include_order=False))

    def test_zero_is_a_real_id_and_final_customer_turn_is_preserved(self):
        text = PAIR + 'CLIENT Ещё один вопрос'
        dialogues = logs.prepare('export.xlsx', excel(text, '[1, 2, 3]', dialogue_id=0))
        self.assertEqual(dialogues[0]['id'], '0')
        self.assertEqual(dialogues[0]['messages'][-1]['content'], 'Ещё один вопрос')

    def test_jsonl_validates_entire_upload_before_any_commit(self):
        valid = {
            'id': 'one',
            'messages': [{'role': 'user', 'content': 'Вопрос'}, {'role': 'assistant', 'content': 'Ответ'}],
        }
        invalid = dict(valid, id='two', messages=[{'role': 'assistant', 'content': None}])
        data = ('\n'.join(json.dumps(row) for row in (valid, invalid))).encode()
        with patch.object(logs.store, 'save') as save, self.assertRaises(ValueError):
            logs.prepare('logs.jsonl', data)
        save.assert_not_called()

    def test_duplicate_ids_are_rejected(self):
        dialogue = {
            'id': 'one',
            'messages': [{'role': 'user', 'content': 'Вопрос'}, {'role': 'assistant', 'content': 'Ответ'}],
        }
        data = ('\n'.join(json.dumps(dialogue) for _ in range(2))).encode()
        with self.assertRaises(ValueError):
            logs.prepare('logs.jsonl', data)

    def test_complete_transcript_uses_the_stable_dialogue_id(self):
        dialogue = {
            'id': 'one',
            'messages': [{'role': 'user', 'content': 'Вопрос'}, {'role': 'assistant', 'content': 'Ответ'}],
        }
        with patch.object(logs.store, 'load', return_value=[dialogue]):
            self.assertEqual(logs.read('one'), dialogue)
            self.assertIsNone(logs.read('missing'))

    def test_commit_has_one_storage_write(self):
        with patch.object(logs.store, 'replace_inputs') as save:
            self.assertEqual(logs.commit([{'id': 'one', 'messages': []}]), 1)
        save.assert_called_once_with('logs.json', [{'id': 'one', 'messages': []}])
