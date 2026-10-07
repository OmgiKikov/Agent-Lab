"""Versioned rubrics are user rules; built-in sets contain actual criteria, not invented model versions."""

import hashlib

BUILTINS = {
    'tone': (
        'Базовые правила общения',
        [
            ('Обращение', 'Обращайтесь к клиенту вежливо и на «вы».'),
            ('Тон', 'Сохраняйте деловой доброжелательный тон, избегайте канцелярита и лишних извинений.'),
            ('Ясность', 'Отвечайте ясно и по существу, объясняйте незнакомые термины.'),
        ],
    ),
    'code': (
        'Точность ответа',
        [
            (
                'Факты',
                'Фактические утверждения должны подтверждаться предоставленной базой знаний. '
                'Если доказательств нет, критерий нельзя оценить.',
            ),
            (
                'Инструменты',
                'Используйте только доступные агенту инструменты. Оценивайте вызовы только при наличии их записи.',
            ),
            (
                'Отсутствие выдумок',
                'Не придумывайте факты, ссылки и результаты действий. При недостатке информации сообщите об этом.',
            ),
        ],
    ),
}


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


def builtin(kind: str) -> dict:
    name, rows = BUILTINS[kind]
    policy = '\n\n'.join(f'{title}: {text}' for title, text in rows)
    criteria = [
        {
            'id': f'{kind}-{i}',
            'name': title,
            'text': text,
            'quote': text,
            'condition': '',
            'acceptable': '',
            'sourceId': source(kind, name, policy)['id'],
            'observation': ('knowledge' if i == 1 else 'tool' if i == 2 else 'reply') if kind == 'code' else 'reply',
        }
        for i, (title, text) in enumerate(rows, 1)
    ]
    return {'name': name, 'policy': policy, 'criteria': criteria}


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
