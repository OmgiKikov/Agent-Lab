"""Versioned rubrics are the rules people give: the Lab writes no rules of its own."""

import hashlib


def brief(version: dict) -> dict:
    """A version of rules as a list names it: which set and which version, without its policy and criteria."""
    return {key: version[key] for key in ('id', 'setId', 'name', 'version') if key in version}


def source(kind: str, name: str, policy: str) -> dict:
    key = 'tone-of-voice' if kind == 'tone' else 'accuracy-judge'
    return {
        'id': key,
        'kind': key,
        'name': name,
        'origin': name,
        'content': policy,
        'sha256': hashlib.sha256(policy.encode()).hexdigest(),
    }


def validate_criteria(criteria: list[dict], kind: str) -> list[dict]:
    if not 1 <= len(criteria) <= 100:
        raise ValueError('В наборе должно быть от 1 до 100 критериев.')
    seen, found = set(), []
    for rule in criteria:
        name, text = str(rule.get('name') or '').strip(), str(rule.get('text') or '').strip()
        key = str(rule.get('id') or '').strip()
        if not key or key in seen or not name or not text:
            raise ValueError(
                'Заполните название и формулировку каждого критерия. Идентификаторы не должны повторяться.'
            )
        seen.add(key)
        found.append(
            {
                'quote': '',
                'condition': '',
                'acceptable': '',
                'observation': 'reply',
                **rule,
                'name': name,
                'text': text,
                'sourceId': 'tone-of-voice' if kind == 'tone' else 'accuracy-judge',
            }
        )
    return found
