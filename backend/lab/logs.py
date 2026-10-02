"""Import and read complete recorded conversations.

Excel exports contain CLIENT/AGENT turns and the real message count in the order column. Exports repeat
exchanges: every exchange twice, or only some of them, sometimes with a trailing dot on the copy. A run of
identical adjacent exchanges is read as one or more real exchanges; the reading is kept only when the message
count admits exactly one. A customer's actual repeated question survives whenever the count requires it.
A conversation the count cannot settle is quarantined with its reason; the rest of the file is imported.

Each conversation keeps the export's service columns (`meta`): the date, channel, entry point, the agents that
took part, the acquiring agent's status codes and the operator flag. Customer identifiers are kept only as a
pseudonymous key for grouping. Parsing is pure so a cancelled import cannot commit from a thread.
"""

import ast
import hashlib
import io
import json
import re
from dataclasses import dataclass, field
from xml.etree.ElementTree import ParseError
from zipfile import BadZipFile

from openpyxl import load_workbook
from openpyxl.utils.exceptions import InvalidFileException

from . import store

FILE = 'logs.json'
META = 'logs-meta.json'  # the name and time of the last upload, and how its rows were read
SHEET = 'Данные'
ID, TEXT, ORDER = 'Id диалога', 'Текст', 'Порядок сообщения в диалоге'
MARKER = re.compile(r'\b(CLIENT|AGENT)\b')
ACQUIRING = 'agent-ckr-pa-acquiring'  # the agent under test, as the status columns name it
# Service columns read into meta: column → key. Customer ids are hashed into clientKey, never stored as is.
COLUMNS = {
    'Дата': 'date',
    'dialogSummary': 'summary',
    'agentCode': 'agents',
    'actionCode': 'actions',
    'Канал': 'channel',
    'Источник': 'entrySource',
    'Поверхность': 'surface',
    'Вызов оператора в диалоге': 'operator',
}
STATUS_COLUMNS = ('Статус код 200', 'Статус код 202_1', 'Статус код 202_2', 'Статус код 202_5', 'Статус код 202_7')
CLIENT_COLUMNS = ('epkId', 'sflEpkId', 'digitalUserId')
MAX_READINGS = 2  # counting stops here: two readings already make a conversation ambiguous


class Quarantined(ValueError):
    """This conversation cannot be read unambiguously; the rest of the file is still usable."""


@dataclass
class Upload:
    """The conversations of one upload and how its rows were read."""

    dialogues: list[dict]
    rows: int = 0
    exact: int = 0
    collapsed: int = 0
    quarantined: list[dict] = field(default_factory=list)

    def report(self) -> dict:
        return {
            'rows': self.rows,
            'accepted': len(self.dialogues),
            'exact': self.exact,
            'collapsed': self.collapsed,
            'quarantined': self.quarantined,
        }


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
        raise Quarantined('Не удалось прочитать порядок сообщений в диалоге') from error
    if not isinstance(value, list) or not value:
        raise Quarantined('Порядок сообщений должен содержать непустой список')
    return len(value)


def _same(text: str) -> str:
    """Comparison form of an exported message: the copy differs only in spacing and a trailing dot."""
    return re.sub(r'\s+', ' ', text).strip().rstrip('. ').strip()


def _exchanges(messages: list[dict]) -> list[list[int]]:
    """Message indexes grouped into exchanges: a customer message and the agent messages after it."""
    groups: list[list[int]] = []
    for index, message in enumerate(messages):
        if message['role'] == 'user' or not groups:
            groups.append([index])
        else:
            groups[-1].append(index)
    return groups


def _readings(sizes: list[int], repeats: list[int], target: int) -> tuple[int, list[int]]:
    """How many choices of a real multiplicity 1..r for each run of r identical exchanges reach the target count
    (capped at MAX_READINGS), and the choice itself when it is the only one."""
    ways = [[0] * (target + 1) for _ in range(len(sizes) + 1)]
    ways[len(sizes)][0] = 1
    for run in range(len(sizes) - 1, -1, -1):
        for total in range(target + 1):
            rests = (total - m * sizes[run] for m in range(1, repeats[run] + 1))
            ways[run][total] = min(MAX_READINGS, sum(ways[run + 1][rest] for rest in rests if rest >= 0))
    if ways[0][target] != 1:
        return ways[0][target], []
    chosen, total = [], target
    for run in range(len(sizes)):
        multiplicity = next(
            m
            for m in range(1, repeats[run] + 1)
            if total - m * sizes[run] >= 0 and ways[run + 1][total - m * sizes[run]]
        )
        chosen.append(multiplicity)
        total -= multiplicity * sizes[run]
    return 1, chosen


def _export_messages(messages: list[dict], count: int) -> tuple[list[dict], list[int]]:
    """The real messages and their positions in the exported text; Quarantined when the count cannot decide."""
    if len(messages) == count:
        return messages, list(range(len(messages)))
    # Known doubled layout: every exchange followed by its exact copy. It decides even where several runs could trade
    # multiplicities, e.g. a real repeated exchange exported twice.
    if count % 2 == 0 and len(messages) == 2 * count:
        blocks = range(0, len(messages), 4)
        if all(messages[i : i + 2] == messages[i + 2 : i + 4] for i in blocks):
            kept = [i + offset for i in blocks for offset in (0, 1)]
            return [messages[i] for i in kept], kept
    runs: list[list[list[int]]] = []  # runs of identical adjacent exchanges
    for group in _exchanges(messages):
        key = [(messages[i]['role'], _same(messages[i]['content'])) for i in group]
        previous = runs[-1][0] if runs else None
        if previous is not None and [(messages[i]['role'], _same(messages[i]['content'])) for i in previous] == key:
            runs[-1].append(group)
        else:
            runs.append([group])
    found, reading = _readings([len(run[0]) for run in runs], [len(run) for run in runs], count)
    if not found:
        raise Quarantined(f'В тексте {len(messages)} сообщений, по «Порядку» {count}: повторы не сводятся к нему')
    if found > 1:
        raise Quarantined('Повторы обменов допускают несколько прочтений при том же числе сообщений')
    kept = [i for run, multiplicity in zip(runs, reading, strict=True) for group in run[:multiplicity] for i in group]
    return [messages[index] for index in kept], kept


def _listed(value: object) -> list[str]:
    """A list column of the export ("['WEB']"); a plain value becomes a one-item list."""
    if value is None:
        return []
    text = str(value).strip()
    if text.startswith('['):
        try:
            parsed = ast.literal_eval(text)
        except (ValueError, SyntaxError):
            return [text]
        return [str(item) for item in parsed] if isinstance(parsed, list | tuple) else [str(parsed)]
    return [text] if text else []


def _meta(row: tuple, column: dict[str, int], number: int) -> dict:
    def cell(name: str) -> object:
        return row[column[name]] if name in column and column[name] < len(row) else None

    meta: dict = {'row': number}
    for name, key in COLUMNS.items():
        value = cell(name)
        if key in ('agents', 'actions'):
            meta[key] = _listed(value)
        elif key in ('channel', 'entrySource', 'surface'):
            meta[key] = ', '.join(_listed(value)) or None
        elif key == 'operator':
            meta[key] = None if value is None else str(value).strip().lower() == 'true'
        else:
            meta[key] = None if value is None else str(value).strip()
    statuses = [
        name.removeprefix('Статус код ') for name in STATUS_COLUMNS if any(ACQUIRING in v for v in _listed(cell(name)))
    ]
    meta['acquiringStatuses'] = statuses
    client = next((str(cell(name)) for name in CLIENT_COLUMNS if cell(name) not in (None, '')), None)
    meta['clientKey'] = hashlib.sha256(client.encode()).hexdigest()[:12] if client else None
    return meta


def from_excel(data: bytes) -> Upload:
    workbook = load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    try:
        sheet = workbook[SHEET] if SHEET in workbook.sheetnames else workbook.worksheets[0]
        rows = sheet.iter_rows(values_only=True)
        header = [str(value or '').strip() for value in next(rows, ())]
        missing = [name for name in (ID, TEXT, ORDER) if name not in header]
        if missing:
            raise ValueError('В выгрузке нет колонок: ' + ', '.join(f'«{name}»' for name in missing))
        column = {name: index for index, name in enumerate(header) if name}
        upload = Upload([])
        for number, row in enumerate(rows, 2):
            if not any(value is not None for value in row):
                continue
            upload.rows += 1
            dialogue_id = row[column[ID]]
            try:
                count = _message_count(row[column[ORDER]])
                text_messages = turns(str(row[column[TEXT]] or ''))
                messages, kept = _export_messages(text_messages, count)
            except Quarantined as error:
                upload.quarantined.append({'id': str(dialogue_id), 'row': number, 'reason': str(error)})
                continue
            meta = _meta(row, column, number)
            exact = len(text_messages) == count
            meta['import'] = {'status': 'exact' if exact else 'collapsed', 'textMessages': len(text_messages)}
            if not exact:
                meta['import']['kept'] = kept
            upload.exact += exact
            upload.collapsed += not exact
            upload.dialogues.append({'id': dialogue_id, 'messages': messages, 'meta': meta})
        return upload
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
            kept = {'id': dialogue_id, 'messages': normalized}
            if isinstance(dialogue.get('meta'), dict):
                kept['meta'] = dialogue['meta']
            usable.append(kept)
    if not usable:
        raise ValueError('В файле нет разговоров, которые начинаются с клиента и содержат ответ агента')
    return usable


def read_upload(name: str, data: bytes) -> Upload:
    """Validate an entire upload before its caller atomically replaces the stored conversations."""
    if name.lower().endswith('.jsonl'):
        rows = from_jsonl(data)
        upload = Upload(rows, rows=len(rows), exact=len(rows))
    elif name.lower().endswith('.xlsx'):
        try:
            upload = from_excel(data)
        except (BadZipFile, InvalidFileException, ParseError) as error:
            raise ValueError('Не удалось прочитать файл Excel: неверная структура .xlsx') from error
    else:
        raise ValueError('Загрузите файл .xlsx или .jsonl')
    upload.dialogues = _validated(upload.dialogues)
    return upload


def prepare(name: str, data: bytes) -> list[dict]:
    return read_upload(name, data).dialogues


def commit(dialogues: list[dict], name: str | None = None, report: dict | None = None) -> int:
    store.replace_inputs(FILE, dialogues)
    if name:
        store.save(META, {'file': name, 'updatedAt': store.now(), **({'import': report} if report else {})})
    return len(dialogues)


def meta() -> dict:
    """The export the conversations came from: its file name and when it was uploaded, when that is known."""
    return store.load(META) or {'file': None, 'updatedAt': None}
