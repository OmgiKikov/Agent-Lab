#!/usr/bin/env python3
"""Build a small LangWatch evaluation dataset with cited source passages."""

import json
import math
import re
import sys
from collections import Counter
from pathlib import Path


WORD = re.compile(r"[^\W_]{3,}", re.UNICODE)
STOP = {
    "это", "как", "для", "что", "или", "при", "если", "когда", "вам",
    "вас", "все", "можно", "нужно", "через", "есть", "будет", "мне",
    "нас", "вам", "его", "она", "они", "где", "какой", "какая", "какие",
    "клиент", "агент", "client", "agent", "transition", "code",
}


def words(text: str) -> list[str]:
    return [
        word[:7] if len(word) > 8 else word
        for word in WORD.findall(text.casefold().replace("ё", "е"))
        if word not in STOP
    ]


def chunks(text: str, limit: int = 1000) -> list[str]:
    passages: list[str] = []
    current = ""
    for paragraph in text.splitlines():
        paragraph = paragraph.strip()
        if not paragraph:
            continue
        if current and len(current) + len(paragraph) > limit:
            passages.append(current)
            current = ""
        if len(paragraph) > limit:
            if current:
                passages.append(current)
                current = ""
            for start in range(0, len(paragraph), limit):
                passages.append(paragraph[start:start + limit])
        else:
            current = f"{current}\n{paragraph}" if current else paragraph
    if current:
        passages.append(current)
    return passages


def question_text(dialogue: str) -> str:
    customer_turns = re.findall(
        r"\bCLIENT\b(.*?)(?=\bAGENT\b|\bCLIENT\b|$)",
        dialogue,
        flags=re.DOTALL | re.IGNORECASE,
    )
    unique_turns = list(dict.fromkeys(turn.strip() for turn in customer_turns))
    return " ".join(unique_turns[:3] + unique_turns[-2:])[:2500]


def answer_text(dialogue: str) -> str:
    agent_turns = re.findall(
        r"\bAGENT\b(.*?)(?=\bCLIENT\b|\bAGENT\b|$)",
        dialogue,
        flags=re.DOTALL | re.IGNORECASE,
    )
    unique_turns = list(dict.fromkeys(turn.strip() for turn in agent_turns))
    return " ".join(unique_turns[:2])[:1800]


def main() -> None:
    if len(sys.argv) != 5:
        raise SystemExit(
            "Usage: prepare-fact-pilot.py DIALOGUES.jsonl REFERENCES.jsonl IDS.txt OUTPUT.jsonl"
        )
    dialogue_path, reference_path, ids_path, output_path = map(Path, sys.argv[1:])
    wanted = [line.strip() for line in ids_path.read_text().splitlines() if line.strip()]
    dialogues = {row["dialogue_id"]: row for row in map(json.loads, dialogue_path.open())}
    articles = list(map(json.loads, reference_path.open()))

    passages: list[dict] = []
    document_frequency: Counter[str] = Counter()
    for article in articles:
        title_terms = set(words(article["title"]))
        for passage in chunks(article["text"]):
            counts = Counter(words(passage))
            passages.append(
                {
                    "article_id": article["article_id"],
                    "title": article["title"],
                    "text": passage,
                    "counts": counts,
                    "title_terms": title_terms,
                    "length": sum(counts.values()),
                }
            )
            document_frequency.update(counts.keys())

    average_length = sum(item["length"] for item in passages) / len(passages)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8") as output:
        for dialogue_id in wanted:
            dialogue = dialogues[dialogue_id]
            summary_terms = set(words(dialogue["summary"]))
            query_terms = Counter(words(dialogue["summary"]))
            query_terms.update(words(question_text(dialogue["conversation"])))
            query_terms.update(words(answer_text(dialogue["conversation"])))
            query_terms = Counter({term: min(count, 3) for term, count in query_terms.items()})

            ranked = []
            for passage in passages:
                score = 0.0
                for term, query_count in query_terms.items():
                    frequency = passage["counts"].get(term, 0)
                    if not frequency and term not in passage["title_terms"]:
                        continue
                    document_count = document_frequency.get(term, 0)
                    idf = math.log(1 + (len(passages) - document_count + 0.5) / (document_count + 0.5))
                    weight = 2 if term in summary_terms else 1
                    score += weight * query_count * idf * (
                        frequency * 2.2 /
                        (frequency + 1.2 * (0.25 + 0.75 * passage["length"] / average_length))
                        if frequency else 1.5
                    )
                title_hits = summary_terms & passage["title_terms"]
                score += 8 * len(title_hits) / max(1, len(passage["title_terms"]))
                if score:
                    ranked.append((score, passage))
            ranked.sort(key=lambda item: item[0], reverse=True)
            picked = []
            per_article: Counter[str] = Counter()
            for score, passage in ranked:
                if per_article[passage["article_id"]] >= 2:
                    continue
                picked.append((score, passage))
                per_article[passage["article_id"]] += 1
                if len(picked) == 5:
                    break

            record = {
                "dialogue_id": dialogue_id,
                "summary": dialogue["summary"],
                "input": dialogue["conversation"],
                "output": dialogue["conversation"],
                "contexts": [
                    f"Источник: {passage['title']}\n{passage['text']}"
                    for _, passage in picked
                ],
                "source_titles": [passage["title"] for _, passage in picked],
            }
            output.write(json.dumps(record, ensure_ascii=True) + "\n")
            print(dialogue["summary"], "→", ", ".join(dict.fromkeys(record["source_titles"])))


if __name__ == "__main__":
    main()
