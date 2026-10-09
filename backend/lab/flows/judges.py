"""Rubric library and selection, bridged to the existing tone and accuracy workflows."""

from .. import storage
from ..domain import checks, quotes
from ..domain import judges as rules
from . import inputs

DRAFT = 'tone-of-voice-criteria.json'


def library(kind: str) -> dict:
    """The versions of rules of a kind and the one in force. Criteria of tone of voice made while no set was selected
    (before the library) become its first version, dated when they were made; the ones a set an earlier Lab wrote
    itself copied in, while it is still selected, do not."""
    if kind == 'tone' and storage.judges.selected(kind) is None:
        # Under the write lock, asked again: the screens ask for the library twice at once on their first look, and
        # the criteria must become one version, not one per request.
        with storage.transaction():
            draft = storage.documents.load(DRAFT)
            policy = next((s for s in inputs.sources() if s['id'] == checks.TONE_OF_VOICE), None)
            if storage.judges.selected(kind) is None and draft and policy:
                storage.judges.capture_tone(draft, policy, adopted=True)
    selected = storage.judges.active(kind)
    return {'versions': storage.judges.listed(kind), 'selectedId': selected['id'] if selected else None}


def activate(kind: str, version_id: str | None) -> dict:
    with storage.transaction():
        value = storage.judges.get(version_id) if version_id else None
        if version_id and (value is None or value['kind'] != kind):
            raise ValueError('Набор правил не найден.')
        if kind == 'tone' and value is None:
            raise ValueError('Выберите набор правил общения.')
        old = storage.judges.active(kind)
        # Nothing to change only when nothing was selected: a set an earlier Lab wrote itself, still selected, goes
        # with the rules selecting it copied into the sources.
        if storage.judges.selected(kind) is None and value is None:
            return {'kind': 'code', 'mode': 'code'}
        if old and value and old['id'] == value['id']:
            return value
        source_id = checks.TONE_OF_VOICE if kind == 'tone' else 'accuracy-judge'
        sources = [s for s in inputs.sources() if s['id'] != source_id]
        if value:
            sources.append(rules.source(kind, value['name'], value['policy']))
        draft = (storage.documents.load(DRAFT) or {}) if kind == 'tone' else {}
        # The same criteria of the same rules under another name or version: the result judged by them, its scenarios
        # and the revision the screens compare it with stay.
        same = (
            bool(value)
            and draft.get('criteria') == value['criteria']
            and draft.get('sourceSha256') == sources[-1]['sha256']
        )
        inputs.replace_sources(sources)
        storage.judges.select(kind, version_id)
        if same:
            return value
        storage.documents.save(checks.result(kind), None)
        inputs.drop_deck([kind])
        if kind == 'tone':
            source = sources[-1]
            storage.documents.save(
                DRAFT,
                {
                    'revision': value['id'],
                    'createdAt': value['createdAt'],
                    'sourceSha256': source['sha256'],
                    'criteria': value['criteria'],
                    'model': None,
                },
            )
        else:
            storage.documents.save(checks.CODE_CRITERIA, None)
        return value or {'kind': 'code', 'mode': 'code'}


def save(kind: str, name: str, policy: str, criteria: list[dict], set_id: str | None, base_id: str | None) -> dict:
    name, policy = name.strip(), policy.strip()
    if not name or not 20 <= len(policy) <= 50000:
        raise ValueError('Укажите название и правила: от 20 до 50 000 символов.')
    found = rules.validate_criteria(criteria, kind)
    found = [r if quotes.found(r['quote'], policy) else r | {'quote': ''} for r in found]
    with storage.transaction():
        base = storage.judges.get(base_id) if base_id else storage.judges.active(kind)
        value = storage.judges.save(kind, name, policy, _as_before(found, base), set_id=set_id, base_id=base_id)
        activate(kind, value['id'])
        return value


def _as_before(found: list[dict], base: dict | None) -> list[dict]:
    """A criterion the person left as it was keeps its saved form to the key: the form sends every criterion back with
    the fields it fills in (empty clarifications, defaults), and a check is comparable with the ones before it, the
    answers on a criterion carried to it, only while its criteria are the same records (tone.criteria_fingerprint,
    tone.carry_decisions). Renaming the set or editing one criterion changes nothing of the others."""
    before = {rule['id']: rule for rule in (base or {}).get('criteria') or []}

    def bare(rule: dict) -> dict:
        return {key: value for key, value in rule.items() if value not in ('', [], None)}

    return [before[r['id']] if r['id'] in before and bare(before[r['id']]) == bare(r) else r for r in found]


def markdown(version_id: str) -> str:
    value = storage.judges.get(version_id)
    if value is None:
        raise ValueError('Набор правил не найден.')
    lines = [f'# {value["name"]} · v{value["version"]}', '', value['policy'], '', '## Критерии', '']
    for rule in value['criteria']:
        lines.extend([f'### {rule["name"]}', rule['text'], ''])
        for key, label in (('condition', 'Когда применять'), ('acceptable', 'Допустимый ответ'), ('quote', 'Источник')):
            if rule.get(key):
                lines.extend([f'{label}: {rule[key]}', ''])
    return '\n'.join(lines)


def current_markdown(kind: str) -> str:
    value = storage.judges.active(kind)
    if value:
        return markdown(value['id'])
    # Of Точность, the criteria read from the code wait in their own record until the first check; never tone's.
    record = (
        storage.documents.load(checks.result(kind))
        or (storage.documents.load(checks.CODE_CRITERIA) if kind == checks.CODE else None)
        or {}
    )
    criteria = [rule for topic in record.get('topics', []) for rule in topic['rules']]
    if not criteria:
        raise ValueError('Сначала выберите набор или сформируйте критерии.')
    lines = ['# Критерии из кода агента', '']
    for index, rule in enumerate(criteria, 1):
        lines.extend([f'## {index}. {rule.get("name") or rule["text"]}', rule['text'], ''])
        if rule.get('quote'):
            lines.extend(['Источник: ' + rule['quote'], ''])
    return '\n'.join(lines)
