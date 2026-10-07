"""JSON arrays and common CSV chat exports, normalized to the existing conversation validator."""

import csv
import io
import json
from collections.abc import Callable


def text(data: bytes) -> str:
    try:
        return data.decode('utf-8-sig')
    except UnicodeDecodeError as error:
        raise ValueError('Сохраните файл в кодировке UTF-8.') from error


def from_json(data: bytes) -> list[dict]:
    try:
        value = json.loads(text(data))
    except json.JSONDecodeError as error:
        raise ValueError(f'JSON не читается: строка {error.lineno}. Проверьте синтаксис файла.') from error
    if isinstance(value, dict):
        value = value.get('dialogues', value.get('conversations', [value] if 'messages' in value else None))
    if not isinstance(value, list):
        raise ValueError('В JSON нужен массив разговоров с полями id и messages.')
    return value


def from_csv(data: bytes, parse_turns: Callable[[str], list[dict]]) -> list[dict]:
    content = text(data)
    try:
        dialect = csv.Sniffer().sniff(content[:4096], delimiters=',;\t')
    except csv.Error:
        dialect = csv.excel
    reader = csv.DictReader(io.StringIO(content), dialect=dialect)
    names = {str(key).strip() for key in reader.fieldnames or []}
    grouped: dict[str, dict] = {}
    found = []
    for number, raw in enumerate(reader, 2):
        row = {str(key).strip(): value for key, value in raw.items() if key is not None}
        if not any(row.values()):
            continue
        key = row.get('id', row.get('Id диалога', ''))
        if {'role', 'content'} <= names:
            item = grouped.setdefault(key, {'id': key, 'messages': []})
            role = {'client': 'user', 'agent': 'assistant'}.get(
                str(row['role'] or '').strip().lower(), str(row['role'] or '').strip().lower()
            )
            item['messages'].append({'role': role, 'content': row['content']})
        elif 'messages' in names:
            try:
                found.append({'id': key, 'messages': json.loads(row['messages'])})
            except (ValueError, TypeError) as error:
                raise ValueError(f'В строке {number} колонка messages должна содержать JSON-список реплик.') from error
        elif 'Текст' in names or 'text' in names:
            found.append({'id': key, 'messages': parse_turns(row.get('Текст', row.get('text', '')) or '')})
        else:
            raise ValueError('Нужны колонки id, role, content; либо id и messages; либо Id диалога и Текст.')
    return list(grouped.values()) if grouped else found
