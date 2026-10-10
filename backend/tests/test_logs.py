import io
import json
import re
import unittest
from unittest.mock import patch
from zipfile import ZIP_DEFLATED, ZipFile

import support
from openpyxl import Workbook

from lab import storage
from lab.domain import export as logs


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


class LogImportTests(unittest.TestCase):
    def test_malformed_excel_is_a_validation_error(self):
        with self.assertRaisesRegex(ValueError, 'Файл .xlsx повреждён'):
            logs.prepare('broken.xlsx', b'this is not an Excel archive')

    def test_a_short_excel_row_is_left_out_instead_of_failing_the_server(self):
        dialogues, skipped = logs.read_export('export.xlsx', undeclared([['d1', PAIR, '[1, 2]'], ['d2']]))
        self.assertEqual(([d['id'] for d in dialogues], skipped), (['d1'], 1))

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

    def test_a_text_the_order_disagrees_with_is_kept_as_written_never_cut(self):
        other = 'CLIENT Дайте инструкцию\nAGENT Откройте настройки\n'
        dialogues = logs.prepare('export.xlsx', excel(PAIR * 2 + other, '[1, 2, 3, 4]'))
        self.assertEqual(len(dialogues[0]['messages']), 6)

    def test_missing_or_invalid_order_removes_nothing(self):
        for order in (None, 'not JSON', '{}', '[]'):
            with self.subTest(order=order):
                self.assertEqual(len(logs.prepare('export.xlsx', excel(PAIR * 2, order))[0]['messages']), 4)
        with self.assertRaisesRegex(ValueError, 'нет колонок'):
            logs.prepare('export.xlsx', excel(PAIR, None, include_order=False))

    def test_the_banks_export_writes_a_conversation_on_one_line(self):
        text = 'CLIENT Какая комиссия за эквайринг? AGENT Комиссия 1,8%. CLIENT А для СБП? AGENT 0,7%.'
        dialogues = logs.prepare('export.xlsx', excel(text, '[1, 2]'))
        self.assertEqual(
            [(m['role'], m['content']) for m in dialogues[0]['messages']],
            [
                ('user', 'Какая комиссия за эквайринг?'),
                ('assistant', 'Комиссия 1,8%.'),
                ('user', 'А для СБП?'),
                ('assistant', '0,7%.'),
            ],
        )
        doubled = logs.prepare('export.xlsx', excel('CLIENT Привет AGENT Здравствуйте ' * 2, '[1, 2]'))
        self.assertEqual(len(doubled[0]['messages']), 2)

    def test_a_turn_after_a_buttons_code_is_a_turn(self):
        text = 'CLIENT Реквизиты AGENT Вот они ` ` ` transition-code ACCOUNT_S_QR ` ` ` CLIENT QR AGENT Счёт откроется'
        dialogues = logs.prepare('export.xlsx', excel(text, '[1, 2, 3, 4]'))
        self.assertEqual([m['role'] for m in dialogues[0]['messages']], ['user', 'assistant', 'user', 'assistant'])

    def test_an_empty_turn_is_no_message(self):
        dialogues = logs.prepare('export.xlsx', excel('CLIENT Вопрос AGENT CLIENT Ещё вопрос AGENT Ответ', '[1, 2]'))
        self.assertEqual([m['content'] for m in dialogues[0]['messages']], ['Вопрос', 'Ещё вопрос', 'Ответ'])

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
        with patch.object(storage.documents, 'save') as save, self.assertRaises(ValueError):
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
            (
                (good + '\n\nid;client;agent\n').encode(),
                r'^Строка 3 не читается как JSON\. В датасете нужен один разговор в строке\.$',
            ),
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
        support.lab(self)
        dialogue = {
            'id': 'one',
            'messages': [{'role': 'user', 'content': 'Вопрос'}, {'role': 'assistant', 'content': 'Ответ'}],
        }
        storage.dialogues.replace([dialogue])
        self.assertEqual(storage.dialogues.get('one'), dialogue)
        self.assertIsNone(storage.dialogues.get('missing'))

    def test_an_export_says_how_many_conversations_a_check_cannot_read(self):
        talk = [{'role': 'user', 'content': 'Вопрос'}, {'role': 'assistant', 'content': 'Ответ'}]
        rows = [
            {'id': 'usable', 'messages': talk},
            {'id': 'agent-first', 'messages': list(reversed(talk))},
            {'id': 'no-answer', 'messages': talk[:1]},
        ]
        data = '\n'.join(json.dumps(row, ensure_ascii=False) for row in rows).encode()
        dialogues, skipped = logs.read_export('export.jsonl', data)
        self.assertEqual(([d['id'] for d in dialogues], skipped), (['usable'], 2))


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
        shown = logs.conversation(dialogue)
        self.assertEqual(shown[0], {'role': 'CUSTOMER', 'text': 'Как вернуть терминал?'})
        self.assertEqual(shown[1], {'role': 'AGENT', 'text': 'Нажмите кнопку ниже.\n[Кнопки: TRANSFER_INTO_CHAT]'})
