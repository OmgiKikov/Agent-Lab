"""File storage under lab/data (git-ignored: real conversations never enter the repository)."""
import json
import os
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DATA = Path(os.environ.get('LAB_DATA', ROOT / 'data'))
RUNS = DATA / 'runs'


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec='seconds')


def load(name: str, default=None):
    path = DATA / name
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding='utf-8'))


def save(name: str, value) -> None:
    path = DATA / name
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=1), encoding='utf-8')
    temp.chmod(0o600)
    temp.replace(path)


def runs() -> list[dict]:
    if not RUNS.exists():
        return []
    items = []
    for path in RUNS.glob('*.json'):
        try:
            items.append(json.loads(path.read_text(encoding='utf-8')))
        except (OSError, json.JSONDecodeError):
            continue
    return sorted(items, key=lambda r: r.get('startedAt', ''), reverse=True)


_MARKUP = re.compile(r'[\*_`#>«»"„“”\[\]]+')


def normalized(text: str) -> str:
    text = _MARKUP.sub(' ', (text or '').replace('ё', 'е').replace('Ё', 'Е'))
    return re.sub(r'\s+', ' ', text).strip().lower()


def quote_found(quote: str, text: str) -> bool:
    """A quote counts only if every meaningful fragment appears verbatim (modulo markup/whitespace)."""
    haystack = normalized(text)
    parts = [normalized(p) for p in re.split(r'\.{3}|…', quote or '')]
    parts = [p for p in parts if p]
    return bool(parts) and sum(len(p) for p in parts) >= 8 and all(p in haystack for p in parts)
