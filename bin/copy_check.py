"""The texts people read — of the screens (frontend/src) and of the service's messages (backend/lab) — without the
signs of machine-written text listed in docs/WRITING.md («Нейрослоп: чего не пишем»).

Reads string literals and JSX text that have Cyrillic letters in them; comments, docstrings and the prompts the models
read are not texts for people. A line where a sign is meant says so with a comment `copy: ok` (on it or the line
above). Exits 1 with every finding, 0 when there is none.
"""

import ast
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CYRILLIC = re.compile(r'[А-Яа-яЁё]')
# What the models read, not people: prompts and the customers the simulator plays.
NOT_FOR_PEOPLE = {'prompts.py', 'personas.py'}
SIGNS = [
    (r'\bявля(ет|ют)ся\b', 'канцелярит «является»: скажите прямо'),
    (r'\bосуществл', 'канцелярит «осуществлять»: глагол действия'),
    (r'\bпроизвод(ит|ят)ся\b', 'канцелярит «производится»: глагол действия'),
    (r'\bданн(ый|ая|ое|ого|ой|ому|ом|ым)\b', 'канцелярит «данный»: «этот» или ничего'),
    (r'\bв рамках\b', 'канцелярит «в рамках»'),
    (r'\bв целях\b', 'канцелярит «в целях»: «чтобы»'),
    (r'\bна основании\b', 'канцелярит «на основании»: «по»'),
    (r'\bпожалуйста\b', 'вежливая вода «пожалуйста»'),
    (r'\bобратите внимание\b', 'вежливая вода «обратите внимание»'),
    (r'\bк сожалению\b', 'вежливая вода «к сожалению»'),
    (r'\bспасибо\b', 'вежливая вода «спасибо»'),
    (r'\bуспешно\b', 'оценка «успешно»: скажите, что случилось'),
    (r'\b(стоит|важно|следует) (отметить|учитывать|помнить)\b', 'вводная вода'),
    (r'\bпо сути\b|\bтаким образом\b|\bв целом\b|\bна самом деле\b|\bчестно говоря\b', 'вводная вода'),
    (r'\bдавайте\b', 'обращение чат-бота «давайте»'),
    (r'\bне просто\b[^.?]*,\s*а\b', 'формула «не просто X, а Y»'),
    (r'\bэто не\b[^.?]*—\s*это\b', 'формула «это не X — это Y»'),
    (r'!', 'восклицательный знак'),
    (r';', 'точка с запятой: два предложения'),
    (r'[\U0001F300-\U0001FAFF✅❌✨⚡]', 'эмодзи'),
]
SIGNS = [(re.compile(pattern, re.IGNORECASE), why) for pattern, why in SIGNS]
ENTITY = re.compile(r'&#?\w+;')


class Script:
    """The string literals, template literals and JSX text of a TypeScript file, each with where it starts. Comments
    and regular expressions are skipped; code inside a template's ${…} is read as code, its strings as strings."""

    # After these a slash starts a regular expression, not a division.
    BEFORE_REGEX = set('(,=:[!&|?{};+-*%<>~^')

    def __init__(self, text: str) -> None:
        self.text, self.found = text, []
        self.mask = list(text)  # the code alone: strings, comments and expressions blanked, for JSX text
        self.code(0)
        for match in re.finditer(r'>([^<>{}]+)', ''.join(self.mask)):
            self.found.append((match.start(1), match.group(1)))

    def blank(self, start: int, end: int) -> None:
        for at in range(start, min(end, len(self.text))):
            if self.text[at] != '\n':
                self.mask[at] = ' '

    def previous(self, i: int) -> str:
        """The last significant character of code before i, or '' at the start."""
        at = i - 1
        while at >= 0 and (self.mask[at].isspace() or self.mask[at] == ' '):
            at -= 1
        return self.mask[at] if at >= 0 else ''

    def code(self, i: int, inside: bool = False) -> int:
        text, n, depth = self.text, len(self.text), 0
        while i < n:
            c = text[i]
            if inside and c == '}' and depth == 0:
                return i + 1
            if text.startswith('//', i):
                end = text.find('\n', i)
                end = n if end < 0 else end
                self.blank(i, end)
                i = end
            elif text.startswith('/*', i):
                end = text.find('*/', i + 2)
                end = n if end < 0 else end + 2
                self.blank(i, end)
                i = end
            elif c in '"\'':
                i = self.string(i)
            elif c == '`':
                i = self.template(i)
            elif c == '/' and (self.previous(i) in self.BEFORE_REGEX or re.search(r'\breturn\s*$', text[max(0, i - 8) : i])):
                i = self.regex(i)
            else:
                depth += c == '{'
                depth -= c == '}'
                i += 1
        return i

    def string(self, i: int) -> int:
        quote, end, n = self.text[i], i + 1, len(self.text)
        while end < n and self.text[end] != quote and self.text[end] != '\n':
            end += 2 if self.text[end] == '\\' else 1
        self.found.append((i, self.text[i + 1 : end]))
        self.blank(i, end + 1)
        return end + 1

    def template(self, i: int) -> int:
        text, n, at, start, parts = self.text, len(self.text), i + 1, i + 1, []
        while at < n:
            if text[at] == '\\':
                at += 2
            elif text[at] == '`':
                break
            elif text.startswith('${', at):
                parts.append(text[start:at])
                at = self.code(at + 2, inside=True)
                start = at
            else:
                at += 1
        parts.append(text[start:at])
        self.found.append((i, ' '.join(parts)))
        self.blank(i, at + 1)
        return at + 1

    def regex(self, i: int) -> int:
        text, n, at, klass = self.text, len(self.text), i + 1, False
        while at < n and text[at] != '\n':
            if text[at] == '\\':
                at += 2
                continue
            if text[at] == '[':
                klass = True
            elif text[at] == ']':
                klass = False
            elif text[at] == '/' and not klass:
                break
            at += 1
        at += 1
        while at < n and text[at].isalpha():
            at += 1
        self.blank(i, at)
        return at


def script_texts(text: str) -> list[tuple[int, str]]:
    """The texts of a TypeScript file people may read, each with where it starts (Script)."""
    return Script(text).found


def python_texts(text: str) -> list[tuple[int, str]]:
    """The string constants of a Python module, each with its line; docstrings are not texts for people."""
    tree = ast.parse(text)
    docstrings = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Module | ast.ClassDef | ast.FunctionDef | ast.AsyncFunctionDef) and node.body:
            first = node.body[0]
            if isinstance(first, ast.Expr) and isinstance(first.value, ast.Constant):
                docstrings.add(id(first.value))
    lines = text.splitlines(keepends=True)
    starts = [0]
    for line in lines:
        starts.append(starts[-1] + len(line))
    return [
        (starts[node.lineno - 1], node.value)
        for node in ast.walk(tree)
        if isinstance(node, ast.Constant) and isinstance(node.value, str) and id(node) not in docstrings
    ]


def findings(path: Path) -> list[str]:
    text = path.read_text(encoding='utf-8')
    texts = python_texts(text) if path.suffix == '.py' else script_texts(text)
    lines = text.splitlines()
    found = []
    for start, value in texts:
        if not CYRILLIC.search(value):
            continue
        number = text.count('\n', 0, start) + 1
        nearby = lines[max(0, number - 2) : number + value.count('\n')]
        if any('copy: ok' in line for line in nearby):
            continue
        clean = ENTITY.sub(' ', value)
        for sign, why in SIGNS:
            if sign.search(clean):
                shown = ' '.join(value.split())
                found.append(f'{path.relative_to(ROOT)}:{number}: {why} — «{shown[:100]}»')
    return found


def main() -> int:
    paths = [*sorted((ROOT / 'frontend/src').rglob('*.ts')), *sorted((ROOT / 'frontend/src').rglob('*.tsx'))]
    paths += [p for p in sorted((ROOT / 'backend/lab').rglob('*.py')) if p.name not in NOT_FOR_PEOPLE]
    found = [line for path in paths for line in findings(path)]
    for line in found:
        print(line)
    print(f'Приметы нейрослопа в текстах: {len(found)} (docs/WRITING.md)' if found else 'Тексты без примет нейрослопа')
    return 1 if found else 0


if __name__ == '__main__':
    sys.exit(main())
