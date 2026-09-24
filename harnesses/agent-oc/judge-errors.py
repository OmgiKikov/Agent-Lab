#!/usr/bin/env python3
"""Почему судья отклонён: причины отказа и один исходный ответ из сохранённого прогона.

    python harnesses/agent-oc/judge-errors.py RUN_ID [--data-dir .agent-lab]

Когда отчёт пишет «Judge response rejected», сам ответ судьи и причина отказа лежат в аудите судьи,
а в markdown-отчёт не попадают. Полный аудит каждого разговора Lab хранит рядом с прогоном —
`.agent-lab/RUN_ID.judge/<id разговора>.json`, в самой записи остаётся только квитанция; в прогонах,
записанных до этого, аудит лежит в записи (`trials[].judgeAudit`). Скрипт читает оба места,
группирует причины и показывает по одному исходному ответу на каждую, чтобы было видно, что именно
не понравилось проверке: формат JSON, лишние поля, несуществующие события или неточные цитаты.

Ничего не вызывает и ничего не меняет — только читает.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter
from pathlib import Path
from typing import Any, Dict, Iterator

RAW_PREVIEW = 1500
# Идентификатор разговора — имя файла аудита: только такие имена читаются из папки прогона.
_IDENTIFIER = re.compile(r"^[a-zA-Z0-9_-]{1,80}$")


def audits(directory: Path, record: Dict[str, Any]) -> Iterator[Dict[str, Any]]:
    """Аудит судьи по каждому разговору прогона: из файла рядом с прогоном, а в старых прогонах — из записи."""
    sidecars = directory / f"{record.get('id')}.judge"
    for trial in record.get("trials", []):
        trial_id = str(trial.get("id", ""))
        path = sidecars / f"{trial_id}.json"
        if _IDENTIFIER.match(trial_id) and path.is_file():
            yield json.loads(path.read_text(encoding="utf-8"))
        elif trial.get("judgeAudit"):
            yield trial["judgeAudit"]


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("run_id", help="Идентификатор прогона")
    parser.add_argument("--data-dir", type=Path, default=Path(__file__).resolve().parents[2] / ".agent-lab", help="Папка данных Lab")
    args = parser.parse_args(argv[1:])
    if not _IDENTIFIER.match(args.run_id):
        print(f"Некорректный идентификатор прогона: {args.run_id}", file=sys.stderr)
        return 2
    path = args.data_dir / f"{args.run_id}.json"
    if not path.exists():
        print(f"Нет файла прогона: {path}", file=sys.stderr)
        return 2
    record = json.loads(path.read_text(encoding="utf-8"))

    reasons: Counter[str] = Counter()
    samples: dict[str, str] = {}
    attempts = 0
    for audit in audits(args.data_dir, record):
        for attempt in audit.get("attempts", []):
            attempts += 1
            error = attempt.get("error")
            if not error:
                continue
            reason = error.split("\n")[0][:300]
            reasons[reason] += 1
            samples.setdefault(reason, attempt.get("raw") or "(ответа нет)")

    print(f"Попыток судьи: {attempts}, отклонено: {sum(reasons.values())}")
    for reason, count in reasons.most_common():
        print(f"\n=== {count} × {reason}")
        print("--- исходный ответ судьи ---")
        print(samples[reason][:RAW_PREVIEW])
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
