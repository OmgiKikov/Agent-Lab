"""JSON files in data/: the Lab's only storage."""

import json
import uuid
from datetime import UTC, datetime
from typing import Any

from .settings import DATA

RUNS = DATA / 'runs'


def now() -> str:
    return datetime.now(UTC).isoformat(timespec='seconds')


def load(name: str, default: Any = None) -> Any:
    path = DATA / name
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding='utf-8'))


def save(name: str, value: Any) -> None:
    """Atomic write, readable only by the owner (the files hold real conversations)."""
    path = DATA / name
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(f'{path.name}.{uuid.uuid4().hex}.tmp')
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=1), encoding='utf-8')
    temp.chmod(0o600)
    temp.replace(path)


def runs() -> list[dict]:
    """Every run, newest first."""
    if not RUNS.exists():
        return []
    items = []
    for path in RUNS.glob('*.json'):
        try:
            items.append(json.loads(path.read_text(encoding='utf-8')))
        except (OSError, json.JSONDecodeError):
            continue
    return sorted(items, key=lambda r: r.get('startedAt', ''), reverse=True)


def run(run_id: str) -> dict | None:
    return next((r for r in runs() if r['id'] == run_id), None)


def save_run(record: dict) -> None:
    save(f'runs/{record["id"]}.json', record)
