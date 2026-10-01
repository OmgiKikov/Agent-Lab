"""Types of customers the synthetic customer can play: the same situation written in a different manner.

A scenario passed by the ordinary customer and failed by one of these shows where the agent breaks on how people
write, not on what they ask. A type changes only the manner: the goal, the facts and the questions stay the card's.
"""

DEFAULT = 'default'

PERSONAS: dict[str, dict] = {
    DEFAULT: {
        'name': 'обычный',
        'note': 'пишет так же, как в логе',
        'style': '',
    },
    'impatient': {
        'name': 'нетерпеливый',
        'note': 'торопится, пишет коротко, раздражается на уточнения',
        'style': (
            'Ты торопишься и раздражаешься. Пишешь коротко, без приветствий и вежливых слов. '
            'Длинный ответ или лишний уточняющий вопрос вызывают недовольство («можно просто ответить?», «ну и?»). '
            'На уточняющий вопрос всё же отвечаешь, но минимально.'
        ),
    },
    'confused': {
        'name': 'растерянный',
        'note': 'путается и переспрашивает, неточно описывает проблему',
        'style': (
            'Ты плохо понимаешь, что тебе нужно сделать, и путаешься. Описываешь проблему неточно и уточняешь по ходу. '
            'Если ответ непонятен, переспрашиваешь простыми словами («а это где?», «я не понял, что нажимать»).'
        ),
    },
    'typos': {
        'name': 'с ошибками',
        'note': 'пишет на бегу: без заглавных и знаков, с опечатками',
        'style': (
            'Пишешь как в мессенджере на ходу: без заглавных букв и знаков препинания, с опечатками, сокращениями '
            'и пропущенными буквами («скока», «щас», «тернинал», «эквайренг»). Смысл остаётся понятным.'
        ),
    },
    'no_terms': {
        'name': 'без терминов',
        'note': 'не знает банковских слов, объясняет своими',
        'style': (
            'Ты не знаешь банковских терминов и не используешь их, а описываешь всё своими словами: '
            'вместо «эквайринг» — «оплата картой у меня в магазине», вместо «терминал» — «аппарат для карт», '
            'вместо «СБП» или «QR-код» — «оплата по картинке с телефона», вместо «МСС» — «какой-то код».'
        ),
    },
}


def public() -> list[dict]:
    return [{'id': key, 'name': p['name'], 'note': p['note']} for key, p in PERSONAS.items()]


def name(key: str | None) -> str:
    return PERSONAS.get(key or DEFAULT, PERSONAS[DEFAULT])['name']


def style(key: str | None) -> str:
    return PERSONAS.get(key or DEFAULT, PERSONAS[DEFAULT])['style']
