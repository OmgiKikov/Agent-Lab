#!/usr/bin/env python3
"""Split selected conversations into individual answers for factual review.

The original dialogue file is never changed. Repeated identical question/answer
pairs stay traceable through `occurrences`, but need only one model evaluation.
"""

import json
import re
import sys
from pathlib import Path


TURN_MARKER = re.compile(r"\b(CLIENT|AGENT)\b", re.IGNORECASE)


def answer_rows(dialogue: dict) -> list[dict]:
    conversation = dialogue["conversation"]
    markers = list(TURN_MARKER.finditer(conversation))
    customer_history: list[str] = []
    result: list[dict] = []
    seen: dict[tuple[str, str], int] = {}
    answer_number = 0

    for index, marker in enumerate(markers):
        end = markers[index + 1].start() if index + 1 < len(markers) else len(conversation)
        content = conversation[marker.end():end].strip()
        if not content:
            continue
        if marker.group(1).upper() == "CLIENT":
            customer_history.append(content)
            continue
        answer_number += 1
        current_question = customer_history[-1] if customer_history else ""
        signature = (current_question, content)
        if signature in seen:
            result[seen[signature]]["occurrences"].append(answer_number)
            continue
        seen[signature] = len(result)
        prior_questions = list(dict.fromkeys(customer_history[:-1]))[-3:]
        input_text = ""
        if prior_questions:
            input_text = "Предыдущие вопросы клиента:\n" + "\n".join(prior_questions) + "\n"
        input_text += "Текущий вопрос клиента:\n" + current_question
        result.append(
            {
                "dialogue_id": dialogue["dialogue_id"],
                "summary": dialogue["summary"],
                "agent_turn": answer_number,
                "occurrences": [answer_number],
                "input": input_text,
                "output": content,
                "contexts": [],
                "source_titles": [],
            }
        )
    return result


def main() -> None:
    if len(sys.argv) != 4:
        raise SystemExit(
            "Usage: prepare-answer-review.py DIALOGUES.jsonl IDS.txt OUTPUT.jsonl"
        )
    dialogues_path, ids_path, output_path = map(Path, sys.argv[1:])
    wanted = [line.strip() for line in ids_path.read_text().splitlines() if line.strip()]
    dialogues = {row["dialogue_id"]: row for row in map(json.loads, dialogues_path.open())}
    rows = [row for dialogue_id in wanted for row in answer_rows(dialogues[dialogue_id])]
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8") as output:
        for row in rows:
            output.write(json.dumps(row, ensure_ascii=True) + "\n")
    print(f"Prepared {len(rows)} distinct question/answer pairs from {len(wanted)} dialogues")


if __name__ == "__main__":
    main()
