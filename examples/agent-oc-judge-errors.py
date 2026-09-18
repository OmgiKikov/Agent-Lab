#!/usr/bin/env python3
"""Почему судья отклонён: причины отказа и один исходный ответ из сохранённого прогона.

    python examples/agent-oc-judge-errors.py RUN_ID

Когда отчёт пишет «Judge response rejected», сам ответ судьи и причина отказа лежат в JSON
прогона (`trials[].judgeAudit.attempts[]`), а в markdown-отчёт не попадают. Скрипт группирует
причины и показывает по одному исходному ответу на каждую, чтобы было видно, что именно не
понравилось проверке: формат JSON, лишние поля, несуществующие события или неточные цитаты.

Ничего не вызывает и ничего не меняет — только читает `.agent-lab/RUN_ID.json`.
"""

from __future__ import annotations

import json
import sys
from collections import Counter
from pathlib import Path

RAW_PREVIEW = 1500


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(__doc__, file=sys.stderr)
        return 2
    path = Path(__file__).resolve().parent.parent / ".agent-lab" / f"{argv[1]}.json"
    if not path.exists():
        print(f"Нет файла прогона: {path}", file=sys.stderr)
        return 2
    record = json.loads(path.read_text(encoding="utf-8"))

    reasons: Counter[str] = Counter()
    samples: dict[str, str] = {}
    attempts = 0
    for trial in record.get("trials", []):
        for attempt in (trial.get("judgeAudit") or {}).get("attempts", []):
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
