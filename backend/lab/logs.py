"""Import and read complete recorded conversations.

Excel exports contain CLIENT/AGENT turns and the real message count in the order column. Some exports
repeat every exchange twice. Only that complete, count-confirmed export pattern is removed; a customer's
actual repeated question is preserved. Parsing is pure so a cancelled import cannot commit from a thread.
"""

import io
import json
import re
from xml.etree.ElementTree import ParseError
from zipfile import BadZipFile

from openpyxl import load_workbook
from openpyxl.utils.exceptions import InvalidFileException

from . import store

FILE = 'logs.json'
META = 'logs-meta.json'  # the name and time of the last upload
SHEET = 'Данные'
ID, TEXT, ORDER = 'Id диалога', 'Текст', 'Порядок сообщения в диалоге'
MARKER = re.compile(r'\b(CLIENT|AGENT)\b')


def load() -> list[dict]:
    return store.load(FILE, []) or []


def read(dialogue_id: str) -> dict | None:
    """The complete transcript, addressed by its stable imported ID."""
    return next((dialogue for dialogue in load() if dialogue['id'] == dialogue_id), None)


def turns(text: str) -> list[dict]:
    marks = list(MARKER.finditer(text))
    return [
        {
            'role': 'user' if mark.group(1) == 'CLIENT' else 'assistant',
            'content': text[mark.end() : marks[i + 1].start() if i + 1 < len(marks) else len(text)].strip(),
        }
        for i, mark in enumerate(marks)
    ]


def _message_count(order: object) -> int:
    try:
        value = json.loads(str(order))
    except (ValueError, TypeError) as error:
        raise ValueError('Не удалось прочитать порядок сообщений в диалоге') from error
    if not isinstance(value, list) or not value:
        raise ValueError('Порядок сообщений должен содержать непустой список')
    return len(value)


def _export_messages(messages: list[dict], count: int) -> list[dict]:
    if len(messages) == count:
        return messages
    # Known duplicated-export layout: customer+agent, the same customer+agent, then the next exchange.
    # Count is essential: equality of adjacent exchanges alone cannot distinguish an export from a real repeat.
    if count % 2 == 0 and len(messages) == 2 * count:
        blocks = [messages[index : index + 4] for index in range(0, len(messages), 4)]
        if all(block[:2] == block[2:] for block in blocks):
            return [message for block in blocks for message in block[:2]]
    raise ValueError('Текст и порядок сообщений не совпадают; неоднозначные повторы нельзя восстановить')


def from_excel(data: bytes) -> list[dict]:
    workbook = load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    try:
        sheet = workbook[SHEET] if SHEET in workbook.sheetnames else workbook.worksheets[0]
        rows = sheet.iter_rows(values_only=True)
        header = [str(value or '').strip() for value in next(rows, ())]
        missing = [name for name in (ID, TEXT, ORDER) if name not in header]
        if missing:
            raise ValueError('В выгрузке нет колонок: ' + ', '.join(f'«{name}»' for name in missing))
        column = {name: header.index(name) for name in (ID, TEXT, ORDER)}
        dialogues = []
        for row in rows:
            if not any(value is not None for value in row):
                continue
            dialogue_id = row[column[ID]]
            try:
                count = _message_count(row[column[ORDER]])
                messages = _export_messages(turns(str(row[column[TEXT]] or '')), count)
            except ValueError as error:
                raise ValueError(f'Диалог {dialogue_id}: {error}') from error
            dialogues.append({'id': dialogue_id, 'messages': messages})
        return dialogues
    finally:
        workbook.close()


def from_jsonl(data: bytes) -> list[dict]:
    return [json.loads(line) for line in data.decode('utf-8').splitlines() if line.strip()]


def _validated(dialogues: list[dict]) -> list[dict]:
    usable, seen = [], set()
    for index, dialogue in enumerate(dialogues, 1):
        if not isinstance(dialogue, dict):
            raise ValueError(f'Строка {index}: разговор должен быть объектом')
        dialogue_id = dialogue.get('id')
        if isinstance(dialogue_id, bool) or not isinstance(dialogue_id, str | int) or not str(dialogue_id).strip():
            raise ValueError(f'Строка {index}: у разговора нет ID')
        dialogue_id = str(dialogue_id).strip()
        if dialogue_id in seen:
            raise ValueError(f'Повторяется ID диалога: {dialogue_id}')
        seen.add(dialogue_id)
        messages = dialogue.get('messages')
        if not isinstance(messages, list):
            raise ValueError(f'Диалог {dialogue_id}: сообщения должны быть списком')
        normalized = []
        for message in messages:
            if not isinstance(message, dict) or message.get('role') not in ('user', 'assistant'):
                raise ValueError(f'Диалог {dialogue_id}: неизвестная роль сообщения')
            content = message.get('content')
            if not isinstance(content, str) or not content.strip():
                raise ValueError(f'Диалог {dialogue_id}: пустой текст сообщения')
            normalized.append({'role': message['role'], 'content': content.strip()})
        if normalized and normalized[0]['role'] == 'user' and any(m['role'] == 'assistant' for m in normalized):
            usable.append({'id': dialogue_id, 'messages': normalized})
    if not usable:
        raise ValueError('В файле нет разговоров, которые начинаются с клиента и содержат ответ агента')
    return usable


def prepare(name: str, data: bytes) -> list[dict]:
    """Validate an entire upload before its caller atomically replaces the stored conversations."""
    if name.lower().endswith('.jsonl'):
        dialogues = from_jsonl(data)
    elif name.lower().endswith('.xlsx'):
        try:
            dialogues = from_excel(data)
        except (BadZipFile, InvalidFileException, ParseError) as error:
            raise ValueError('Не удалось прочитать файл Excel: неверная структура .xlsx') from error
    else:
        raise ValueError('Загрузите файл .xlsx или .jsonl')
    return _validated(dialogues)


def commit(dialogues: list[dict], name: str | None = None) -> int:
    store.replace_inputs(FILE, dialogues)
    if name:
        store.save(META, {'file': name, 'updatedAt': store.now()})
    return len(dialogues)


def meta() -> dict:
    """The export the conversations came from: its file name and when it was uploaded, when that is known."""
    return store.load(META) or {'file': None, 'updatedAt': None}
