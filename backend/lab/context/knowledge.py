"""What the agent's answers may rely on, so the judge can check instructions against it:
- knowledge-base articles the agent retrieved (recorded by the stand's mock on this Mac; not on prod);
- ready answers written in the agent's code (texts/*.py), matched to the agent's replies by their lines.
"""

import ast
import json
import re
from pathlib import Path

from .. import agents

# In the agent's repository: the knowledge base of the stand's mock, ready answers, service messages.
KB = 'local/mocks/fixtures/kb_gigar.json'
TEXTS = ('src/aigw_service/texts', 'src/aigw_service/exception')
MAX_ARTICLE = 16000
MAX_ARTICLES = 5
MIN_TEXT = 40


def _articles(repo: Path) -> dict:
    try:
        data = json.loads((repo / KB).read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return {}
    return {
        a['id']: {'title': a['title'], 'text': '\n'.join(a.get('passages') or [])[:MAX_ARTICLE]}
        for a in data.get('articles') or []
    }


def _norm(text: str) -> str:
    return re.sub(r'\s+', ' ', re.sub(r'[«»"*#_`]', '', text.replace('ё', 'е'))).strip().lower()


def _ready_answers(repo: Path) -> list[tuple[str, str, str]]:
    """(origin, text, normalized text) of every string constant of 40+ characters in the agent's ready answers
    (texts/*.py) and its service and fallback messages (exception/*.py)."""
    found = []
    for folder in (repo / name for name in TEXTS):
        for path in sorted(folder.glob('*.py')) if folder.exists() else []:
            try:
                tree = ast.parse(path.read_text(encoding='utf-8'))
            except (SyntaxError, UnicodeDecodeError):
                continue
            for node in ast.walk(tree):
                if isinstance(node, ast.Constant) and isinstance(node.value, str) and len(node.value) >= MIN_TEXT:
                    found.append((f'{folder.name}/{path.name}:{node.lineno}', node.value, _norm(node.value)))
    return found


def _matching_answers(reply: str, answers: list[tuple[str, str, str]]) -> list[tuple[str, str]]:
    """Ready answers that contain at least half of the reply's substantial lines."""
    lines = [_norm(line) for line in reply.splitlines() if len(line.strip()) >= 30]
    if not lines:
        return []
    hits = []
    for origin, text, normalized in answers:
        shared = sum(1 for line in lines if line in normalized)
        if shared >= (len(lines) + 1) // 2:
            hits.append((shared, origin, text))
    return [(origin, text) for _, origin, text in sorted(hits, reverse=True)[:2]]


def retrieved(conversation: list[dict]) -> list[dict]:
    repo = agents.repo()
    kb, seen = _articles(repo), []
    for message in conversation:
        for event in message.get('events') or []:
            article = event.get('article')
            if article and article in kb and article not in seen:
                seen.append(article)
    found = [{'article': a, 'title': kb[a]['title'], 'text': kb[a]['text']} for a in seen[:MAX_ARTICLES]]
    ready, answers = {}, _ready_answers(repo)
    for message in conversation:
        if message['role'] == 'agent':
            for origin, text in _matching_answers(message['text'], answers):
                ready.setdefault(origin, text)
    found += [
        {
            'article': origin,
            'title': 'Текст из кода агента (готовый ответ или служебное сообщение)',
            'text': text[:MAX_ARTICLE],
        }
        for origin, text in list(ready.items())[:3]
    ]
    return found
