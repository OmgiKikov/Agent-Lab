#!/usr/bin/env python3
"""Прод-разметка диалогов agent_oc (.xlsx) → файл для `build --dialogues-file`.

Agent Lab строит карточки бизнес-сценариев из реальных диалогов: модель видит только реплики и
обязана ссылаться на `id` диалога-доказательства. Формат входа — `dialogueSchema` из
`src/contracts.ts`: `{id, messages: [{role: user|assistant, content}], outcome}`.

    python3 harnesses/agent-oc/import-dialogues.py \\
        --input "/путь/agent_oc/data/размеченные логи 1607_2007.xlsx" \\
        --multi-turn-only

Рядом пишется `<output>.meta.json`: поверхность, полномочия, ЕПК и коды ответов по каждому
диалогу. В схему Agent Lab эти поля не входят, но по ним карточка настраивается на нужный канал
(запись `session` в `initialState`) и прослеживается до строки разметки.

Оба файла — прод-данные. По умолчанию они ложатся в `.agent-lab/agent-oc/` текущего каталога
(папки 0700, файлы 0600), как данные самого Lab. Путь внутри git-репозитория, который git не
игнорирует, скрипт отвергает и ничего не пишет: иначе ЕПК и диалоги уйдут в коммит.

`outcome` ставится только там, где код ответа говорит сам за себя: `200` — успех, `404` и `500-3` —
провал. Все `202-*` остаются `unknown`: отказ по теме или перевод на оператора может быть и верным
поведением, и провалом, и решать это не конвертеру.

Нужен `openpyxl`. Скрипт ничего не импортирует из agent_oc: он читает только выгрузку.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
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
# Прод-данные ложатся туда же, где Lab держит свои: каталог игнорируется git, права только владельца.
DEFAULT_OUTPUT = Path(".agent-lab") / "agent-oc" / "dialogues.jsonl"


def untracked_refusal(path: Path) -> Optional[str]:
    """Почему нельзя писать прод-данные в `path`: он внутри git-репозитория и git его не игнорирует. None — можно."""
    folder = path.resolve().parent
    while not folder.exists():
        folder = folder.parent
    try:
        top = subprocess.run(["git", "-C", str(folder), "rev-parse", "--show-toplevel"], capture_output=True, text=True, check=False)
    except FileNotFoundError:
        return None  # без git коммита не будет
    if top.returncode != 0:
        return None  # не внутри репозитория
    # Отслеживаемый файл git не игнорирует никогда: данные поверх него ушли бы в коммит его изменением.
    ignored = subprocess.run(["git", "-C", top.stdout.strip(), "check-ignore", "-q", str(path.resolve())], check=False)
    if ignored.returncode == 0:
        return None
    return (f"{path} — внутри git-репозитория {top.stdout.strip()}, и git этот путь не игнорирует: прод-диалоги и ЕПК "
            f"ушли бы в коммит. Уберите --output (по умолчанию {DEFAULT_OUTPUT}) или добавьте путь в .gitignore.")


def write_private(path: Path, text: str) -> None:
    """Файл только для владельца (0600) в папках только для владельца (0700) — как данные Lab в .agent-lab."""
    missing: List[Path] = []
    folder = path.parent
    while not folder.exists():
        missing.append(folder)
        folder = folder.parent
    for created in reversed(missing):
        created.mkdir(mode=0o700)
        os.chmod(created, 0o700)
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
        os.fchmod(stream.fileno(), 0o600)
        stream.write(text)


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
        if args.limit and len(dialogues) >= args.limit:
            break
    return dialogues, meta


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--input", required=True, help="Файл разметки .xlsx")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT,
                        help=f"Путь к .jsonl для --dialogues-file; по умолчанию {DEFAULT_OUTPUT}. Не внутри git-репозитория без .gitignore.")
    parser.add_argument("--sheet", action="append", help="Лист разметки; можно повторять. По умолчанию все.")
    parser.add_argument("--status", action="append", help="Оставить только эти коды ответа; можно повторять.")
    parser.add_argument("--limit", type=int, default=0, help="Только первые N подошедших диалогов. По умолчанию все: "
                        "из длинного лога Agent Lab сам берёт 300 по хешу содержимого, а первые N сдвигают выборку во времени.")
    parser.add_argument("--multi-turn-only", action="store_true", help="Только диалоги, где клиент писал больше одного раза.")
    args = parser.parse_args()

    output: Path = args.output
    meta_path = output.with_suffix(output.suffix + ".meta.json")
    for path in (output, meta_path):
        refusal = untracked_refusal(path)
        if refusal:
            print(f"Не пишу: {refusal}", file=sys.stderr)
            return 2

    dialogues, meta = convert(args)
    if not dialogues:
        print("Под фильтры не попал ни один диалог.", file=sys.stderr)
        return 1

    write_private(output, "".join(json.dumps(item, ensure_ascii=False) + "\n" for item in dialogues))
    write_private(meta_path, json.dumps(meta, ensure_ascii=False, indent=2) + "\n")

    characters = sum(len(message["content"]) for item in dialogues for message in item["messages"])
    print(f"{output}: диалогов {len(dialogues)}, символов {characters}")
    print(f"{meta_path}: поверхность, полномочия и коды ответов по каждому диалогу")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
