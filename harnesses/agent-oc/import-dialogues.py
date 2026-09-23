#!/usr/bin/env python3
"""Прод-разметка диалогов agent_oc (.xlsx) → файл для `build --dialogues-file`.

Agent Lab строит карточки бизнес-сценариев из реальных диалогов: модель видит только реплики и
обязана ссылаться на `id` диалога-доказательства. Формат входа — `dialogueSchema` из
`src/contracts.ts`: `{id, messages: [{role: user|assistant, content}], outcome}`.

    python3 harnesses/agent-oc/import-dialogues.py \\
        --input "/путь/agent_oc/data/размеченные логи 1607_2007.xlsx" \\
        --output dialogues.jsonl --multi-turn-only --limit 60

Рядом пишется `<output>.meta.json`: поверхность, полномочия, ЕПК и коды ответов по каждому
диалогу. В схему Agent Lab эти поля не входят, но по ним карточка настраивается на нужный канал
(запись `session` в `initialState`) и прослеживается до строки разметки.

`outcome` ставится только там, где код ответа говорит сам за себя: `200` — успех, `404` и `500-3` —
провал. Все `202-*` остаются `unknown`: отказ по теме или перевод на оператора может быть и верным
поведением, и провалом, и решать это не конвертеру.

Нужен `openpyxl`. Скрипт ничего не импортирует из agent_oc: он читает только выгрузку.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional, Tuple

SURFACE_BY_SHEET = {
    "GIGAASS": "GIGAASSISTANT",
    "TEXTASS": "TEXTASSISTANT",
    "VOICEASS": "VOICEASSISTANT",
    "VOICECOPILOT": "VOICECOPILOT",
}
# Коды, которые агент отдаёт при собственном сбое (harness_core.ABORT_STATUSES).
FAILURE_STATUSES = {"404", "500-3"}
CLIENT_SPEAKERS = {"client", "клиент"}
_SPEAKER = re.compile(r"(?mi)^[ \t]*(client|agent|operator|клиент|сотрудник|агент)[ \t]*:[ \t]*")
_UNSAFE_ID = re.compile(r"[^a-zA-Z0-9_-]")

MAX_MESSAGES = 60
MAX_CONTENT = 8000
MAX_DIALOGUES = 200


def parse_history(history: str) -> List[Dict[str, str]]:
    """Разбирает `client: "…" / agent: "…"` в реплики Agent Lab, сохраняя порядок."""
    marks = list(_SPEAKER.finditer(history))
    messages: List[Dict[str, str]] = []
    for index, mark in enumerate(marks):
        end = marks[index + 1].start() if index + 1 < len(marks) else len(history)
        content = history[mark.end():end].strip()
        if content.startswith('"') and content.endswith('"') and len(content) > 1:
            content = content[1:-1].strip()
        if not content:
            continue
        role = "user" if mark.group(1).lower() in CLIENT_SPEAKERS else "assistant"
        messages.append({"role": role, "content": content[:MAX_CONTENT]})
    return messages[:MAX_MESSAGES]


def outcome_of(status_code: str) -> str:
    if status_code == "200":
        return "success"
    if status_code in FAILURE_STATUSES:
        return "failure"
    return "unknown"


def dialogue_id(sheet: str, conversation_id: str) -> str:
    return f"{sheet}-{_UNSAFE_ID.sub('-', conversation_id)}"[:80]


def read_rows(path: Path, sheets: Optional[List[str]]) -> Iterator[Tuple[str, Dict[str, Any]]]:
    import openpyxl

    workbook = openpyxl.load_workbook(path, read_only=True, data_only=True)
    for sheet in workbook.sheetnames:
        if sheets and sheet not in sheets:
            continue
        rows = workbook[sheet].iter_rows(values_only=True)
        header = [str(cell or "") for cell in next(rows)]
        for row in rows:
            yield sheet, dict(zip(header, row))


def convert(args: argparse.Namespace) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
    dialogues: List[Dict[str, Any]] = []
    meta: Dict[str, Any] = {}
    for sheet, row in read_rows(Path(args.input), args.sheet):
        conversation_id = str(row.get("conversation_id") or "").strip()
        history = str(row.get("dialogue_history") or "").strip()
        if not conversation_id or not history:
            continue
        messages = parse_history(history)
        if not messages:
            continue
        if args.multi_turn_only and len(messages) < 3:
            continue
        status_code = str(row.get("status_code") or "").strip()
        if args.status and status_code not in args.status:
            continue
        identifier = dialogue_id(sheet, conversation_id)
        dialogues.append({"id": identifier, "messages": messages, "outcome": outcome_of(status_code)})
        meta[identifier] = {
            "sheet": sheet,
            "surface": SURFACE_BY_SHEET.get(sheet, sheet),
            "conversation_id": conversation_id,
            "authority": str(row.get("authority") or "").strip(),
            "branch": str(row.get("branch") or "").strip(),
            "epk_id": str(row.get("epk_id") or "").strip(),
            "sfl_epk_id": str(row.get("sfl_epk_id") or "").strip(),
            "status_code": status_code,
            "expected_status": str(row.get("Ожидаемый код ответа") or "").strip(),
            "expected_answer": str(row.get("Ожидаемый ответ") or "").strip(),
            "date": str(row.get("date") or "").strip(),
        }
        if len(dialogues) >= args.limit:
            break
    return dialogues, meta


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--input", required=True, help="Файл разметки .xlsx")
    parser.add_argument("--output", required=True, help="Путь к .jsonl для --dialogues-file")
    parser.add_argument("--sheet", action="append", help="Лист разметки; можно повторять. По умолчанию все.")
    parser.add_argument("--status", action="append", help="Оставить только эти коды ответа; можно повторять.")
    parser.add_argument("--limit", type=int, default=MAX_DIALOGUES, help=f"Не больше {MAX_DIALOGUES} (предел Agent Lab).")
    parser.add_argument("--multi-turn-only", action="store_true", help="Только диалоги, где клиент писал больше одного раза.")
    args = parser.parse_args()

    if args.limit > MAX_DIALOGUES:
        parser.error(f"Agent Lab принимает не больше {MAX_DIALOGUES} диалогов за раз.")

    dialogues, meta = convert(args)
    if not dialogues:
        print("Под фильтры не попал ни один диалог.", file=sys.stderr)
        return 1

    output = Path(args.output)
    output.write_text("".join(json.dumps(item, ensure_ascii=False) + "\n" for item in dialogues), encoding="utf-8")
    meta_path = output.with_suffix(output.suffix + ".meta.json")
    meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    characters = sum(len(message["content"]) for item in dialogues for message in item["messages"])
    print(f"{output}: диалогов {len(dialogues)}, символов {characters}")
    print(f"{meta_path}: поверхность, полномочия и коды ответов по каждому диалогу")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
