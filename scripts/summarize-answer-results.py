#!/usr/bin/env python3
"""Summarize a LangWatch factual run without losing a bad answer in a long chat."""

import json
import sys
from collections import OrderedDict
from pathlib import Path


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("Usage: summarize-answer-results.py LANGWATCH_RESULTS.json")
    run = json.loads(Path(sys.argv[1]).read_text())
    if len(run["targets"]) != 1 or run["targets"][0]["type"] != "evaluator":
        raise SystemExit("Expected one factual evaluator as the experiment target")

    conversations: OrderedDict[str, dict] = OrderedDict()
    for item in run["dataset"]:
        entry = item["entry"]
        if "agent_turn" not in entry:
            raise SystemExit("This run is not an answer-level dataset")
        # An evaluator target writes its first judgment to predicted.output.
        # run.evaluations are checks of that judgment and must not be mistaken
        # for checks of the bank bot's answer.
        evaluation = (item.get("predicted") or {}).get("output")
        label = (
            evaluation["label"]
            if evaluation and evaluation["status"] == "processed"
            else "NOT_EVALUATED"
        )
        conversation = conversations.setdefault(
            entry["dialogue_id"], {"summary": entry["summary"], "answers": []}
        )
        conversation["answers"].append(
            {"turn": entry["agent_turn"], "occurrences": entry["occurrences"], "label": label}
        )

    priority = ("NOT_EVALUATED", "FACTUAL_ERROR", "NO_EVIDENCE", "SUPPORTED")
    for conversation in conversations.values():
        answers = sorted(conversation["answers"], key=lambda row: row["turn"])
        labels = {answer["label"] for answer in answers}
        overall = next((label for label in priority if label in labels), "NOT_EVALUATED")
        detail = ", ".join(f"ответ {answer['turn']}: {answer['label']}" for answer in answers)
        print(f"{conversation['summary']} → {overall} ({detail})")
    print(f"Итого: {len(conversations)} разговоров, {len(run['dataset'])} разных ответов")


if __name__ == "__main__":
    main()
