#!/usr/bin/env python3
"""Compare every imported LangWatch dataset field with the local source JSONL."""

import json
import sys
from pathlib import Path


def read_source(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.open(encoding="utf-8")]


def read_stored(directory: Path) -> list[dict]:
    files = sorted(directory.glob("chunk-*.jsonl"))
    if not files:
        raise SystemExit(f"No dataset chunks found in {directory}")
    return [
        json.loads(line)["entry"]
        for file in files
        for line in file.open(encoding="utf-8")
    ]


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit("Usage: verify-import.py SOURCE.jsonl DATASET_DIRECTORY")

    expected = read_source(Path(sys.argv[1]))
    actual = read_stored(Path(sys.argv[2]))
    expected_by_id = {row["dialogue_id"]: row for row in expected}
    actual_by_id = {row["dialogue_id"]: row for row in actual}
    if len(expected_by_id) != len(expected) or len(actual_by_id) != len(actual):
        raise SystemExit("Duplicate dialogue IDs found")
    if expected_by_id != actual_by_id:
        missing = len(expected_by_id.keys() - actual_by_id.keys())
        extra = len(actual_by_id.keys() - expected_by_id.keys())
        changed = sum(
            expected_by_id[key] != actual_by_id[key]
            for key in expected_by_id.keys() & actual_by_id.keys()
        )
        raise SystemExit(f"Import differs: {missing} missing, {extra} extra, {changed} changed")

    print(f"Verified {len(actual)} conversations, all fields match exactly")


if __name__ == "__main__":
    main()
