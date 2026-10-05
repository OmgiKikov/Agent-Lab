import io
import json
import re
import unittest
from unittest.mock import patch
from zipfile import ZIP_DEFLATED, ZipFile

from openpyxl import Workbook

from lab import discover, logs


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


def undeclared(rows):
    """A workbook whose sheet does not declare its size, as some exporters write it: openpyxl then reads each row only
    as far as its last filled cell."""
    workbook = Workbook()
    sheet = workbook.active
    sheet.title = logs.SHEET
    for row in [[logs.ID, logs.TEXT, logs.ORDER], *rows]:
        sheet.append(row)
    stream = io.BytesIO()
    workbook.save(stream)
    workbook.close()
    output = io.BytesIO()
    with ZipFile(io.BytesIO(stream.getvalue())) as source, ZipFile(output, 'w', ZIP_DEFLATED) as target:
        for info in source.infolist():
            part = source.read(info)
            if info.filename.startswith('xl/worksheets/'):
                part = re.sub(rb'<dimension[^>]*/>', b'', part)
            target.writestr(info, part)
    return output.getvalue()


PAIR = 'CLIENT Не знаю номер\nAGENT Назовите номер терминала\n'


def contents(dialogue):
    return [message['content'] for message in dialogue['messages']]


class LogImportTests(unittest.TestCase):
    def test_malformed_excel_is_a_validation_error(self):
        with self.assertRaisesRegex(ValueError, 'Файл .xlsx повреждён'):
            logs.prepare('broken.xlsx', b'this is not an Excel archive')

    def test_a_short_excel_row_is_named_instead_of_failing_the_server(self):
        data = undeclared([['d1', PAIR, '[1, 2]'], ['d2']])
        with self.assertRaisesRegex(ValueError, '^В диалоге d2 не читается порядок сообщений'):
            logs.prepare('export.xlsx', data)
        self.assertEqual(len(logs.prepare('export.xlsx', undeclared([['d1', PAIR, '[1, 2]']]))), 1)

    def test_an_archive_without_the_parts_of_a_workbook_is_a_validation_error(self):
        archive = io.BytesIO()
        with ZipFile(archive, 'w') as target:
            target.writestr('readme.txt', 'not a workbook')
        with self.assertRaisesRegex(ValueError, '^Файл .xlsx повреждён'):
            logs.prepare('export.xlsx', archive.getvalue())

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

    def test_ambiguous_partial_duplication_is_rejected_instead_of_truncated(self):
        other = 'CLIENT Дайте инструкцию\nAGENT Откройте настройки\n'
        with self.assertRaises(ValueError):
            logs.prepare('export.xlsx', excel(PAIR * 2 + other, '[1, 2, 3, 4]'))

    def test_missing_or_invalid_order_never_guesses(self):
        for order in (None, 'not JSON', '{}', '[]'):
            with self.subTest(order=order), self.assertRaises(ValueError):
                logs.prepare('export.xlsx', excel(PAIR * 2, order))
        with self.assertRaises(ValueError):
            logs.prepare('export.xlsx', excel(PAIR, None, include_order=False))

    def test_a_marker_word_inside_a_message_stays_in_the_message(self):
        text = 'CLIENT Терминал пишет HOST AGENT NOT FOUND, что делать?\nAGENT Перезагрузите терминал'
        dialogues = logs.prepare('export.xlsx', excel(text, '[1, 2]'))
        self.assertEqual(
            dialogues[0]['messages'],
            [
                {'role': 'user', 'content': 'Терминал пишет HOST AGENT NOT FOUND, что делать?'},
                {'role': 'assistant', 'content': 'Перезагрузите терминал'},
            ],
        )

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

    def test_jsonl_saved_with_a_byte_order_mark_is_read(self):
        dialogue = {
            'id': 'one',
            'messages': [{'role': 'user', 'content': 'Вопрос'}, {'role': 'assistant', 'content': 'Ответ'}],
        }
        data = b'\xef\xbb\xbf' + json.dumps(dialogue, ensure_ascii=False).encode()
        self.assertEqual(logs.prepare('logs.jsonl', data), [dialogue])

    def test_an_unreadable_jsonl_says_which_line_and_what_to_check(self):
        good = json.dumps({'id': 'one', 'messages': [{'role': 'user', 'content': 'Вопрос'}]})
        for data, message in (
            ((good + '\n\nid;client;agent\n').encode(), r'^Строка 3 не читается как JSON\. Нужна выгрузка чата'),
            ('Здравствуйте'.encode('cp1251'), r'^Файл \.jsonl не в кодировке UTF-8'),
        ):
            with self.subTest(message=message), self.assertRaisesRegex(ValueError, message):
                logs.prepare('logs.jsonl', data)

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


class OneLineExportTests(unittest.TestCase):
    """The Voice360 export that writes a whole conversation on one line and repeats some of its messages."""

    def test_a_conversation_on_one_line_is_split_at_its_markers(self):
        text = 'CLIENT как поменять мсс код AGENT Извиняюсь, уточните CLIENT Код терминала AGENT Откройте настройки'
        dialogues = logs.prepare('export.xlsx', excel(text, '[1, 2, 3, 4]'))
        self.assertEqual(
            dialogues[0]['messages'],
            [
                {'role': 'user', 'content': 'как поменять мсс код'},
                {'role': 'assistant', 'content': 'Извиняюсь, уточните'},
                {'role': 'user', 'content': 'Код терминала'},
                {'role': 'assistant', 'content': 'Откройте настройки'},
            ],
        )

    def test_an_exchange_repeated_right_after_itself_is_kept_once(self):
        text = 'CLIENT Вопрос AGENT Ответ CLIENT Вопрос AGENT Ответ CLIENT Ещё AGENT Готово'
        dialogues = logs.prepare('export.xlsx', excel(text, '[1, 2, 3, 4]'))
        self.assertEqual(contents(dialogues[0]), ['Вопрос', 'Ответ', 'Ещё', 'Готово'])

    def test_a_message_repeated_right_after_itself_is_kept_once(self):
        text = 'CLIENT Вопрос AGENT Ответ AGENT Ответ CLIENT Ещё AGENT Готово'
        dialogues = logs.prepare('export.xlsx', excel(text, '[1, 2, 3, 4]'))
        self.assertEqual(contents(dialogues[0]), ['Вопрос', 'Ответ', 'Ещё', 'Готово'])

    def test_a_copy_that_differs_by_the_final_period_is_kept_once_as_first_written(self):
        text = 'CLIENT Вопрос AGENT Ответ CLIENT Вопрос AGENT Ответ.'
        dialogues = logs.prepare('export.xlsx', excel(text, '[1, 2]'))
        self.assertEqual(contents(dialogues[0]), ['Вопрос', 'Ответ'])

    def test_a_one_line_conversation_that_still_does_not_match_its_order_is_left_out(self):
        data = undeclared(
            [
                ['d1', 'CLIENT Вопрос AGENT Ответ', '[1, 2]'],
                ['d2', 'CLIENT Вопрос AGENT Ответ CLIENT Другой AGENT Иной', '[1, 2]'],
            ]
        )
        self.assertEqual([dialogue['id'] for dialogue in logs.prepare('export.xlsx', data)], ['d1'])

    def test_a_file_with_no_matching_one_line_conversation_is_refused(self):
        text = 'CLIENT Вопрос AGENT Ответ CLIENT Другой AGENT Иной'
        with self.assertRaisesRegex(ValueError, '^В файле нет разговоров'):
            logs.prepare('export.xlsx', excel(text, '[1, 2]'))

    def test_a_conversation_written_line_by_line_that_does_not_match_its_order_still_fails_the_file(self):
        with self.assertRaisesRegex(ValueError, '^В диалоге d1 текст не совпадает с порядком сообщений'):
            logs.prepare('export.xlsx', excel(PAIR * 3, '[1, 2]'))


class SeenTextTests(unittest.TestCase):
    def test_a_logged_reply_is_judged_as_the_customer_saw_it(self):
        dialogue = {
            'id': 'd1',
            'messages': [
                {'role': 'user', 'content': 'Как вернуть терминал?'},
                {
                    'role': 'assistant',
                    'content': 'Нажмите кнопку ниже.\n` ` ` transition-code TRANSFER_INTO_CHAT ` ` `',
                },
            ],
        }
        shown = discover.conversation(dialogue)
        self.assertEqual(shown[0], {'role': 'CUSTOMER', 'text': 'Как вернуть терминал?'})
        self.assertEqual(shown[1], {'role': 'AGENT', 'text': 'Нажмите кнопку ниже.\n[Кнопки: TRANSFER_INTO_CHAT]'})
