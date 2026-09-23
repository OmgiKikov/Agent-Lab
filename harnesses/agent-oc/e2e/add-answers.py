#!/usr/bin/env python3
"""Добавляет ответы владельца на вопросы черновика в задание отдельным материалом.

    python3 add-answers.py task.json answers.json

Так же делала команда clarify, которой больше нет: ответы становятся источником с явной
пометкой «ответы владельца», исходные материалы не меняются, черновик собирается заново.
"""

import json
import sys


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print(__doc__, file=sys.stderr)
        return 2
    task_path, answers_path = argv[1], argv[2]
    with open(task_path, encoding="utf-8") as handle:
        task = json.load(handle)
    with open(answers_path, encoding="utf-8") as handle:
        answers = json.load(handle)
    content = "\n\n".join(f"Вопрос: {a['question']}\nОтвет владельца: {a['answer']}" for a in answers)
    task["materials"] = [m for m in task["materials"] if m["name"] != "Ответы владельца на вопросы черновика"]
    task["materials"].append({"name": "Ответы владельца на вопросы черновика", "content": content})
    with open(task_path, "w", encoding="utf-8") as handle:
        json.dump(task, handle, ensure_ascii=False, indent=2)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
