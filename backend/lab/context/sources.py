"""Where the rules come from: the agent's own prompts and tools, read from its repository.

- prompts: every prompt-like string constant in the agent's Python code (path:line and hash kept);
- tools: the business-system tools the agent is configured with and the modules that call them.
"""

import ast
import hashlib
import re
from pathlib import Path

from .. import store

MIN_PROMPT = 600
MAX_TOTAL = 60000  # characters of prompts handed to the planner


def _sha(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()[:12]


def _looks_like_prompt(text: str) -> bool:
    cyrillic = sum(1 for ch in text.lower() if 'а' <= ch <= 'я' or ch == 'ё')
    markers = ('Ты ', 'ты ', '###', 'Ответ', 'правил', 'Используй', 'Верни', 'клиент')
    return len(text) >= MIN_PROMPT and cyrillic > 0.3 * len(text) and any(m in text for m in markers)


def prompts(repo: Path) -> list[dict]:
    found, seen = [], set()
    for path in sorted((repo / 'src').rglob('*.py')):
        if 'test' in path.name or '_tests' in str(path):
            continue
        try:
            tree = ast.parse(path.read_text(encoding='utf-8'))
        except (SyntaxError, UnicodeDecodeError):
            continue
        for node in ast.walk(tree):
            if isinstance(node, ast.Constant) and isinstance(node.value, str) and _looks_like_prompt(node.value):
                text = node.value.strip()
                digest = _sha(text)
                if digest in seen:
                    continue
                seen.add(digest)
                origin = f'{path.relative_to(repo)}:{node.lineno}'
                found.append({'kind': 'prompt', 'name': origin, 'origin': origin, 'sha256': digest, 'content': text})
    # The customer-facing answer prompt first, then the longest ones, within the planner's budget.
    found.sort(key=lambda s: ('ассистент' not in s['content'][:400], -len(s['content'])))
    kept, total = [], 0
    for source in found:
        if total + len(source['content']) <= MAX_TOTAL:
            kept.append(source)
            total += len(source['content'])
    return kept


def tools(repo: Path) -> dict | None:
    config = repo / 'src/aigw_service/config.py'
    if not config.exists():
        return None
    aliases = dict(
        re.findall(
            r'(sbe_tool_name_\w+)\s*:\s*str\s*=\s*Field\(validation_alias="(SBE_TOOL_NAME_\w+)"',
            config.read_text(encoding='utf-8'),
        )
    )
    env = {}
    for name in ('local/env.local', '.env'):
        path = repo / name
        if path.exists():
            env.update(re.findall(r'^(SBE_TOOL_NAME_\w+)\s*=\s*"?([^"\n]+)"?', path.read_text(encoding='utf-8'), re.M))
    code = {
        p: p.read_text(encoding='utf-8', errors='ignore')
        for p in (repo / 'src').rglob('*.py')
        if p != config and '_tests' not in str(p)
    }
    lines = []
    for field, alias in sorted(aliases.items(), key=lambda kv: kv[1]):
        users = sorted(str(p.relative_to(repo)) for p, text in code.items() if field in text)
        lines.append(f'{env.get(alias, alias)} ({alias}) — вызывается в: {", ".join(users) or "нигде не вызывается"}')
    if not lines:
        return None
    content = 'Инструменты систем банка, доступные агенту (из config.py и .env):\n' + '\n'.join(lines)
    return {
        'kind': 'tools',
        'name': 'Инструменты агента',
        'origin': 'src/aigw_service/config.py + .env',
        'sha256': _sha(content),
        'content': content,
    }


FILE = 'sources.json'


def load() -> list[dict]:
    """The sources collected last time."""
    return store.load(FILE, []) or []


def collect(repo: Path) -> list[dict]:
    """Read the current repository; committing a collected snapshot belongs to the calling job."""
    if not (repo / 'src').is_dir():
        raise RuntimeError(f'Нет кода агента в {repo}: укажите репозиторий на шаге «агент».')
    collected = prompts(repo)
    catalog = tools(repo)
    if catalog:
        collected.append(catalog)
    if not collected:
        raise RuntimeError(f'В {repo} не найдено ни промптов, ни инструментов агента.')
    for index, source in enumerate(collected, 1):
        source['id'] = f's{index}'
    return collected
