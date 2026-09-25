#!/usr/bin/env python3
"""Eval-выгрузка agent_oc с разметкой `expected_rag_id` → golden-кейсы с верифицируемым эталоном.

Асессор уже записал, какую статью базы знаний агент обязан достать на вопрос клиента. Каждая такая
строка становится карточкой с эталоном `{"origin": "assessor", "source": {"doc": <expected_rag_id>}}`,
из которого Agent Lab сам выводит точную проверку «агент нашёл статью N». Проверка измерима, потому что
адаптер `examples/agent-oc-adapter.py` отдаёт статьи, полученные через `fetch_rag_document`, в `retrievals`.

    python3 examples/agent-oc-rag-cases.py --input ../agent_oc/data/eval_ino_rag.xlsx \\
        --output .agent-lab/rag-golden.json --limit 5

Результат — массив golden-кейсов для `agent_lab_build` (goldenFile). Строки без `expected_rag_id`
пропускаются. ЕПК берутся из строки, иначе из аргументов, иначе остаются адаптеру; файл результата держите в `.agent-lab`:
в нём могут оказаться идентификаторы клиентов.

Нужен `openpyxl`. Скрипт ничего не импортирует из agent_oc: он читает только выгрузку.
"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any, Dict, Iterator, List

MAX_CASES = 40
_UNSAFE_ID = re.compile(r"[^a-zA-Z0-9_-]")


def read_rows(path: Path) -> Iterator[Dict[str, Any]]:
    import openpyxl

    workbook = openpyxl.load_workbook(path, read_only=True, data_only=True)
    for sheet in workbook.worksheets:
        rows = sheet.iter_rows(values_only=True)
        header = [str(cell or "") for cell in next(rows)]
        for row in rows:
            yield dict(zip(header, row))


def cell(row: Dict[str, Any], name: str) -> str:
    value = row.get(name)
    return "" if value is None else str(value).strip()


def case_id(row: Dict[str, Any], index: int) -> str:
    raw = cell(row, "case_id") or f"rag_{index}"
    return _UNSAFE_ID.sub("_", raw)[:60]


def session(row: Dict[str, Any], epk_ul: str, epk_fl: str) -> Dict[str, Any]:
    record = {"surface": cell(row, "sender") or "GIGAASSISTANT", "authority": cell(row, "authority") or "3"}
    # Без ЕПК адаптер подставляет своё значение по умолчанию: RAG-вопросу клиент не нужен.
    for field, column, fallback in (("epk_ul", "epk_id_ul", epk_ul), ("epk_fl", "epk_id_fl", epk_fl)):
        value = cell(row, column) or fallback
        if value:
            record[field] = value
    return record


def case(row: Dict[str, Any], index: int, epk_ul: str, epk_fl: str) -> Dict[str, Any]:
    question = cell(row, "question")
    article = cell(row, "expected_rag_id")
    replies = cell(row, "client_replies")
    return {
        "id": case_id(row, index),
        "title": question[:200],
        "goal": f"Получить от агента ответ на вопрос: «{question}»"[:3000],
        "opening": question[:3000],
        "facts": (f"Клиент знает только свой вопрос. Если агент уточнит, клиент отвечает: {replies}" if replies
                  else "Клиент знает только то, что написал в своём вопросе.")[:5000],
        "behavior": "Отвечай на уточнения агента только известными фактами; закончи, когда получишь ответ по существу или поймёшь, что его не будет.",
        "maxFollowUps": 2,
        "successCriteria": f"Агент достаёт статью базы знаний {article}, размеченную асессором, и отвечает по ней",
        "initialState": {
            "records": {
                "session": session(row, epk_ul, epk_fl),
                "result": {"status_code": "", "produced_by": "", "seconds": 0},
            },
            "writableFields": ["status_code", "produced_by", "seconds"],
            "transientFailures": 0,
        },
        "references": [{"id": "assessor_rag", "origin": "assessor", "confirmed": True, "source": {"doc": article}}],
    }


def build(args: argparse.Namespace) -> List[Dict[str, Any]]:
    cases: List[Dict[str, Any]] = []
    seen: set = set()
    for row in read_rows(Path(args.input)):
        if not cell(row, "question") or not cell(row, "expected_rag_id"):
            continue
        item = case(row, len(cases) + 1, args.epk_ul, args.epk_fl)
        if item["id"] in seen:
            continue
        seen.add(item["id"])
        cases.append(item)
        if len(cases) >= args.limit:
            break
    if not cases:
        raise SystemExit("Ни в одной строке нет пары question + expected_rag_id.")
    return cases


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--input", required=True, help="Eval-выгрузка .xlsx с колонками question и expected_rag_id")
    parser.add_argument("--output", required=True, help="Куда записать массив golden-кейсов")
    parser.add_argument("--limit", type=int, default=MAX_CASES, help=f"Не больше {MAX_CASES} карточек; на первый прогон разумно 3-5")
    parser.add_argument("--epk-ul", default="", help="ЕПК ЮЛ, если его нет в строке")
    parser.add_argument("--epk-fl", default="", help="ЕПК ФЛ, если его нет в строке")
    args = parser.parse_args()
    if args.limit > MAX_CASES:
        parser.error(f"Agent Lab принимает не больше {MAX_CASES} карточек за прогон.")

    cases = build(args)
    Path(args.output).write_text(json.dumps(cases, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    articles = sorted({c["references"][0]["source"]["doc"] for c in cases}, key=lambda doc: (len(doc), doc))
    print(f"{args.output}: карточек {len(cases)}, эталонных статей {len(articles)}: {', '.join(articles)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
