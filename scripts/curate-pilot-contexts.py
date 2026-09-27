#!/usr/bin/env python3
"""Keep reviewed source snippets and update three local LangWatch records."""

import json
import os
import sys
from pathlib import Path
from urllib.parse import quote
from urllib.request import Request, urlopen


def main() -> None:
    if len(sys.argv) != 6:
        raise SystemExit(
            "Usage: curate-pilot-contexts.py PILOT.jsonl SELECTION.json "
            "STORED_CHUNK.jsonl DATASET_ID REVIEWED.jsonl"
        )
    source_path, selection_path, chunk_path, dataset_id, output_path = sys.argv[1:]
    api_key = os.environ.get("LANGWATCH_API_KEY")
    if not api_key:
        raise SystemExit("LANGWATCH_API_KEY is required")

    source = {row["dialogue_id"]: row for row in map(json.loads, Path(source_path).open())}
    selection = json.loads(Path(selection_path).read_text())
    stored = [json.loads(line) for line in Path(chunk_path).open()]
    reviewed = []

    for record in stored:
        row = dict(source[record["entry"]["dialogue_id"]])
        indexes = selection.get(row["summary"])
        if not indexes:
            raise SystemExit(f"No reviewed contexts for {row['summary']}")
        row["contexts"] = [row["contexts"][index] for index in indexes]
        row["source_titles"] = [row["source_titles"][index] for index in indexes]
        url = (
            "http://127.0.0.1:5560/api/dataset/"
            f"{quote(dataset_id, safe='')}/records/{quote(record['id'], safe='')}"
        )
        body = json.dumps({"entry": row}, ensure_ascii=False).encode("utf-8")
        request = Request(
            url,
            data=body,
            method="PATCH",
            headers={
                "Content-Type": "application/json",
                "X-Auth-Token": api_key,
                "Authorization": f"Bearer {api_key}",
            },
        )
        with urlopen(request, timeout=20) as response:
            if response.status != 200:
                raise SystemExit(f"Update failed for {row['summary']}: HTTP {response.status}")
        reviewed.append(row)
        print(f"Reviewed {row['summary']}: {len(row['contexts'])} source excerpts")

    with Path(output_path).open("w", encoding="utf-8") as output:
        for row in reviewed:
            output.write(json.dumps(row, ensure_ascii=True) + "\n")


if __name__ == "__main__":
    main()
