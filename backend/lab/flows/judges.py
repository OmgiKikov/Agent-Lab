"""Rubric library and selection, bridged to the existing tone and accuracy workflows."""

from .. import storage
from ..domain import checks, quotes
from ..domain import judges as rules
from . import inputs

DRAFT = 'tone-of-voice-criteria.json'


def library(kind: str) -> dict:
    """The versions of rules of a kind and the one in force. Criteria of tone of voice made while no set was selected
    (before the library) become its first version; the ones a set an earlier Lab wrote itself copied in, while it is
    still selected, do not."""
    if kind == 'tone' and storage.judges.selected(kind) is None:
        draft = storage.documents.load(DRAFT)
        policy = next((s for s in inputs.sources() if s['id'] == checks.TONE_OF_VOICE), None)
        if draft and policy:
            storage.judges.capture_tone(draft, policy)
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
        inputs.replace_sources(sources)
        storage.judges.select(kind, version_id)
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
        value = storage.judges.save(kind, name, policy, found, set_id=set_id, base_id=base_id)
        activate(kind, value['id'])
        return value


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
    record = storage.documents.load(checks.result(kind)) or storage.documents.load(checks.CODE_CRITERIA) or {}
    criteria = [rule for topic in record.get('topics', []) for rule in topic['rules']]
    if not criteria:
        raise ValueError('Сначала выберите набор или сформируйте критерии.')
    lines = ['# Критерии из кода агента', '']
    for index, rule in enumerate(criteria, 1):
        lines.extend([f'## {index}. {rule.get("name") or rule["text"]}', rule['text'], ''])
        if rule.get('quote'):
            lines.extend(['Источник: ' + rule['quote'], ''])
    return '\n'.join(lines)
