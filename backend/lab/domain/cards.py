"""The customer of a scenario: one logged acquiring episode read into a card, every item with a quote the code found in
the log. Pure functions; the model's part is roles/card.py.

A card holds the task, what the customer knows and how they know it, what they saw, how they write and how they
reacted to the agent. The simulator reads only this customer part (`situation`, rendered here from the fields, never
retold by a model); the frozen criteria of its topic are a separate binding for the judge.
"""

import json
import random
import re
import statistics
from collections import Counter

from . import quotes

SEED = 20261002  # the same fictional digits for the same conversation
TRIGGERS = {
    'unclear_question': 'агент задаёт непонятный тебе вопрос',
    'repeated_clarification': 'агент снова переспрашивает',
    'wrong_object': 'агент понял не тот объект или не ту задачу',
    'inapplicable_instruction': 'инструкция не подходит или её нельзя выполнить',
    'no_progress': 'разговор не продвигается',
    'identifier_request': 'агент просит номер или реквизиты',
    'choice_offer': 'агент предлагает выбрать вариант',
    'instruction': 'агент даёт инструкцию',
    'handoff_offer': 'агент предлагает оператора',
    'resolved': 'вопрос решён',
}
SAID = {
    'before': 'уже сказано в чате до этого вопроса',
    'opening': 'уже есть в первом сообщении',
    'later': 'сообщаешь сам позже',
    'on_request': 'говоришь, если спросят',
}
ENTRY = {'after_greeting': 'после приветствия', 'after_other_topic': 'после другого вопроса'}
IDENTIFIERS = ('terminal', 'organization')
VARIANTS = ('knows', 'looks_up', 'unknown')  # what the customer can say about an identifier the log never settled
GREETING = re.compile(r'^\W*(здравствуй|добр|привет|доброе)', re.I)
POLITE = re.compile(r'пожалуйста|спасибо|подскажите|будьте добры', re.I)
MASK = re.compile(r'[#*]+')
# One masked value: runs of # and * with short pieces between them (a masked id like «a* - #b # - #»).
MASKED_VALUE = re.compile(r'[#*]+(?:[\s\\/.:,\w-]{0,6}?[#*]+)*')
FOREIGN = re.compile(r'[぀-ヿ㐀-鿿가-힯]')  # the model sometimes slips into CJK
# An observation is the customer's own try in the world; one about the chat or the agent is the old agent's answer.
ABOUT_CHAT = re.compile(r'\b(агент|бот|чат|ассистент|оператор|ответил|отказал|посоветовал|сказал)\w*', re.I)
# What the agent's message must show for a trigger to name it; the other triggers are judged by the extractor alone.
# The export masks digits, so numbered steps read «#.» as often as «1.». A step number is short and opens a sentence
# or a line; a masked id at the end of a sentence («обращения #####.») is not one.
ASKS = re.compile(
    r'\?|\b(уточните|укажите|напишите|выберите|назовите|сообщите|подскажите|предоставьте|пришлите|отправьте)\b', re.I
)
STEPS = re.compile(
    r'(^|(?<![#\d])[\n:.!?;])\s*[#\d]{1,2}[.)]\s'
    r'|\b(перейдите|нажмите|выберите|откройте|зайдите|войдите|проверьте|оформите|заполните|повторите'
    r'|воспользуйтесь|обратитесь|используйте|сделайте|подключите|скачайте|установите|отправьте|подпишите'
    r'|перезагрузите|отключите|включите|выключите|подождите|введите|вставьте)\b'
    r'|следующими способами',
    re.I,
)
TRIGGER_NEEDS = {
    'unclear_question': (ASKS,),
    'repeated_clarification': (ASKS,),
    'choice_offer': (ASKS,),
    'identifier_request': (ASKS, re.compile(r'номер|инн|реквизит|мерчант|терминал|точк|tid|договор', re.I)),
    'handoff_offer': (re.compile(r'оператор|специалист|поддержк|горяч\w* лини|позвон|отделени|менеджер', re.I),),
    'instruction': (STEPS,),
}
PAST = re.compile(r'\b(раньше|ранее|как (уже )?(делал|было)|в прошлый|в прошлом|обычно)\b', re.I)
TRANSITION = re.compile(r'`\s*`\s*`\s*transition-code\s*([\w-]*)\s*`\s*`\s*`\.?')


def readable(value: dict) -> dict:
    """The extractor's answer, if a card can be read from it: in Russian, and with a name, a goal and the episode's
    start unless it says the conversation has no acquiring task. A ValueError asks the model again."""
    if FOREIGN.search(json.dumps(value, ensure_ascii=False)):
        raise ValueError('card text switched to another script')
    if value.get('eligible') is False:
        return value
    for field in ('name', 'goal'):
        if not isinstance(value.get(field), str) or not value[field].strip():
            raise ValueError(f'card needs {field}')
    if not isinstance((value.get('episode') or {}).get('start'), int):
        raise ValueError('card needs episode.start')
    return value


def events(dialogue: dict) -> list[dict]:
    """The chat as the extractor reads it: numbered events, interface codes apart from the agent's words."""
    found = []
    for n, message in enumerate(dialogue['messages'], 1):
        text = message['content']
        codes = [code for code in TRANSITION.findall(text) if code]
        event = {'n': n, 'role': 'CUSTOMER' if message['role'] == 'user' else 'AGENT', 'text': TRANSITION.sub('', text)}
        if codes:
            event['interface'] = codes
        found.append(event)
    return found


def chat(dialogue: dict) -> dict:
    """What the extractor is told about the chat besides its events: its channel and whether other agents took part."""
    meta = dialogue.get('meta') or {}
    agents = meta.get('agents') or []
    return {'channel': meta.get('channel'), 'otherAgentsInChat': bool(set(agents) - {'ACQUIRING_AGENT'})}


def _found(quote: object, text: str, role: str) -> bool:
    """The quote stands in the message (quotes.spoken); a customer's masks are their words, an agent's # and * are
    as often its Markdown."""
    return isinstance(quote, str) and quotes.spoken(quote, text, masks=role == 'user')


def _holds_value(quote: str) -> bool:
    """A quote that carries an identifier itself: five or more digits, or a value the export masked."""
    return len(re.sub(r'\D', '', quote)) >= 5 or bool(MASK.search(quote))


def _fits(trigger: str, agent_text: str) -> bool:
    """The agent's message shows what the trigger says it did: a question, a request for a number, a handoff, steps."""
    return all(pattern.search(agent_text) for pattern in TRIGGER_NEEDS.get(trigger, ()))


def grounded(value: dict, messages: list[dict]) -> tuple[dict, Counter]:
    """Only items whose quotes stand in the cited message of the right speaker; the rest is counted, not kept."""

    def said(n: object, quote: object, role: str) -> bool:
        if not isinstance(n, int) or not 1 <= n <= len(messages):
            return False
        return messages[n - 1]['role'] == role and _found(quote, messages[n - 1]['content'], role)

    kept, dropped = {}, Counter()

    def text(item: dict, *fields: str) -> bool:
        return all(isinstance(item.get(f), str) and item[f].strip() for f in fields)

    lists = {
        'circumstances': lambda x: text(x, 'text') and said(x.get('n'), x.get('quote'), 'user'),
        'observations': lambda x: text(x, 'action', 'result')
        and not ABOUT_CHAT.search(x['action'] + ' ' + x['result'])
        and said(x.get('n'), x.get('quote'), 'user'),
        # Learned from the agent: its words or the customer's echo of them.
        'facts': lambda x: text(x, 'text')
        and (
            said(x.get('n'), x.get('quote'), 'user')
            or (x.get('status') == 'learned_from_agent' and said(x.get('n'), x.get('quote'), 'assistant'))
        ),
        'reactions': lambda x: text(x, 'trigger', 'response')
        and x['trigger'] in TRIGGERS
        and said(x.get('n'), x.get('quote'), 'user')
        and said(x.get('agentN'), x.get('agentQuote'), 'assistant')
        and x['agentN'] < x['n']
        and _fits(x['trigger'], messages[x['agentN'] - 1]['content']),
    }
    for field, valid in lists.items():
        items = [x for x in value.get(field) or [] if isinstance(x, dict)]
        kept[field] = [x for x in items if valid(x)]
        dropped[field] = len(items) - len(kept[field])
    # A guess only where nothing was observed, about how the customer answers: no past, no numbers.
    observed = {x['trigger'] for x in kept['reactions']}
    offered = [x for x in value.get('hypotheses') or [] if isinstance(x, dict)]
    hypotheses = [
        x
        for x in offered
        if text(x, 'trigger', 'response')
        and x['trigger'] in TRIGGERS
        and x['trigger'] not in observed
        and not PAST.search(x['response'])
        and not re.search(r'\d', x['response'])
    ]
    dropped['hypotheses'] = len(offered) - len(hypotheses)
    kept['hypotheses'] = [{'trigger': x.get('trigger'), 'response': x['response']} for x in hypotheses[:2]]
    kept['notEstablished'] = [str(x) for x in value.get('notEstablished') or [] if str(x).strip()]
    given = value.get('identifiers') if isinstance(value.get('identifiers'), dict) else {}
    for name in IDENTIFIERS:
        item = given.get(name) if isinstance(given.get(name), dict) else {}  # a malformed one is not established
        status = item.get('status')
        # Knowing it means the customer typed the value: a merchant's name is not its INN or terminal number.
        shown = status == 'does_not_know' or _holds_value(str(item.get('quote') or ''))
        cited = said(item.get('n'), item.get('quote'), 'user')
        if status in ('knows', 'masked_in_source', 'does_not_know') and shown and cited:
            kept[name] = {'status': status, 'quote': item['quote']}
        else:
            dropped['identifiers'] += status in ('knows', 'masked_in_source', 'does_not_know')
            kept[name] = {'status': 'not_established'}
    return kept, dropped


def _filled(opening: str, filled: object) -> str | None:
    """The opening with its masks filled, if the model changed nothing but the masked runs."""
    if not MASK.search(opening):
        return opening
    if not isinstance(filled, str) or MASK.search(filled):
        return None
    pattern = '.{1,60}?'.join(re.escape(part) for part in MASKED_VALUE.split(opening.strip()))
    return filled.strip() if re.fullmatch(pattern, filled.strip(), re.S) else None


def _digits(opening: str, seed: str) -> str:
    """Masked digits (#) as fixed digits of the card; hidden text (*) stays: its kind is unknown."""
    rng = random.Random(f'{SEED}:{seed}')
    return re.sub(r'#+', lambda m: ''.join(rng.choice('123456789') for _ in range(max(4, len(m.group())))), opening)


def identifiers(kept: dict, seed: str) -> dict:
    """What the customer can say about each identifier: from the log where it shows, else a variant of this card
    (not calibrated: how often customers know their terminal number is not estimated yet)."""
    rng = random.Random(f'{SEED}:{seed}')
    result = {}
    for name in IDENTIFIERS:
        status = kept[name]['status']
        if status == 'not_established':
            result[name] = {'value': rng.choice(VARIANTS), 'basis': 'variant'}
        else:
            result[name] = {'value': 'unknown' if status == 'does_not_know' else 'knows', 'basis': 'log'}
    return result


def style(texts: list[str]) -> dict:
    """How the customer writes, counted from their own messages in the episode."""
    letters = [t for t in texts if t[:1].isalpha()]
    return {
        'messages': len(texts),
        'words': statistics.median(len(t.split()) for t in texts) if texts else 0,
        'greeting': bool(texts and GREETING.match(texts[0])),
        'polite': any(POLITE.search(t) for t in texts),
        'capital': round(sum(t[0].isupper() for t in letters) / len(letters), 2) if letters else None,
        'endMark': round(sum(t.rstrip()[-1:] in '.!?' for t in texts) / len(texts), 2) if texts else None,
    }


def _words(n: int) -> str:
    form = (
        'слово'
        if n % 10 == 1 and n % 100 != 11
        else 'слова'
        if 2 <= n % 10 <= 4 and not 12 <= n % 100 <= 14
        else 'слов'
    )
    return f'{n} {form}'


def _manner(features: dict, samples: list[str]) -> str:
    def share(value: float | None, often: str, rarely: str) -> str:
        return '' if value is None else often if value >= 0.5 else rarely

    parts = [
        f'обычно {_words(round(features["words"]))} в сообщении',
        'здороваешься' if features['greeting'] else 'без приветствия',
        'вежливые слова есть' if features['polite'] else 'без вежливых слов',
        share(features['capital'], 'с заглавной буквы', 'со строчной буквы'),
        share(features['endMark'], 'ставишь знак в конце', 'без знака в конце'),
    ]
    line = 'Как ты пишешь: ' + '; '.join(p for p in parts if p) + '.'
    if samples:
        line += '\nОбразцы твоей манеры (не повторяй их без повода): ' + ' / '.join(f'«{s}»' for s in samples)
    return line


def brief(card: dict) -> str:
    """The customer's part of the card as the simulator reads it: what the customer wants, knows and does."""
    lines = [f'Твоя задача: {card["goal"]}' + (f' Речь именно о: {card["object"]}.' if card.get('object') else '')]
    if card['episode']['entry'] in ENTRY:
        lines.append(f'К этому вопросу ты перешёл {ENTRY[card["episode"]["entry"]]}.')
    if card['circumstances']:
        lines.append('Обстоятельства:\n' + '\n'.join(f'- {x["text"]}' for x in card['circumstances']))
    known = []
    for fact in card['facts']:
        if fact.get('status') == 'learned_from_agent':
            continue  # the old agent's words, not what this customer brings
        if fact.get('status') == 'does_not_know':
            known.append(f'- не знаешь: {fact["text"]}')
            continue
        note = {'believes': 'так ты считаешь, но можешь ошибаться', 'masked_in_source': 'значение ты знаешь'}
        extra = [note.get(fact.get('status'), ''), SAID.get(fact.get('said'), '')]
        known.append(f'- {fact["text"]}' + ''.join(f' ({e})' for e in extra if e))
    if known:
        lines.append('Что ты знаешь:\n' + '\n'.join(known))
    if card['notEstablished']:
        lines.append(
            'По настоящему разговору не известно (не придумывай подробностей):\n'
            + '\n'.join(f'- {x}' for x in card['notEstablished'])
        )
    words = {'knows': 'знаешь', 'looks_up': 'наизусть не помнишь, можешь посмотреть', 'unknown': 'не знаешь'}
    names = {'terminal': 'Номер терминала', 'organization': 'ИНН и реквизиты организации'}
    lines.append('\n'.join(f'{names[k]}: {words[v["value"]]}.' for k, v in card['identifiers'].items()))
    if card['observations']:
        lines.append(
            'Что получается, когда пробуешь (говори об этом, только если дошло до этого действия):\n'
            + '\n'.join(f'- {x["action"]} → {x["result"]}' for x in card['observations'])
        )
    reactions = [f'- если {TRIGGERS.get(x["trigger"], x["trigger"])}: {x["response"]}' for x in card['reactions']]
    if reactions:
        lines.append('Как ты реагировал в настоящем разговоре (только если случится то же):\n' + '\n'.join(reactions))
    guesses = [f'- если {TRIGGERS.get(x["trigger"], x["trigger"])}: {x["response"]}' for x in card['hypotheses']]
    if guesses:
        lines.append(
            'Возможно, но не проверено (новых фактов и результатов к этому не добавляй):\n' + '\n'.join(guesses)
        )
    lines.append(_manner(card['style'], card.get('samples') or []))
    return '\n'.join(lines)


def starts(messages: list[dict], start: object) -> bool:
    """Whether an episode can start at this message: a customer's one of the conversation."""
    return isinstance(start, int) and 1 <= start <= len(messages) and messages[start - 1]['role'] == 'user'


def customer(value: dict, dialogue: dict, start: int | None = None) -> dict:
    """The customer part of a card from the extractor's answer (readable, eligible): the items the code found in the
    log, the episode's opening with its masks filled, the manner counted from the customer's own messages, and the
    brief the simulator reads (situation). start: where the catalog's reading put the episode; the card then describes
    the episode its business scenario was given for, whatever the extractor said."""
    messages, source = dialogue['messages'], str(dialogue['id'])
    meta = dialogue.get('meta') or {}
    agents = meta.get('agents') or []
    kept, dropped = grounded(value, messages)
    said = value['episode']['start']
    if starts(messages, start):
        dropped['episode'] = int(said != start)
    elif starts(messages, said):
        start = said
    else:
        start, dropped['episode'] = 1, 1
    for fact in kept['facts']:
        # When it was said follows from where its quote stands, not from the model's label.
        if fact.get('status') == 'learned_from_agent':
            fact['said'] = None  # the agent said it; the customer brings nothing
        elif fact['n'] < start:
            fact['said'] = 'before'
        elif fact['n'] == start:
            fact['said'] = 'opening'
        elif fact.get('said') == 'opening':
            fact['said'] = 'later'
    texts = [m['content'] for m in messages[start - 1 :] if m['role'] == 'user']
    quoted = {x['quote'] for x in kept['reactions']}
    samples = [t for t in texts[1:] if not MASK.search(t) and len(t) <= 160 and t not in quoted][:2]
    filled = _filled(texts[0], value.get('openingFilled'))
    opening = filled or _digits(texts[0], source)
    card = {
        'name': value['name'].strip(),
        'goal': value['goal'].strip().rstrip('.') + '.',
        'object': str(value.get('object') or '').strip().rstrip('.'),
        'episode': {
            'start': start,
            'entry': (value.get('episode') or {}).get('entry'),
            'scope': 'acquiring_only' if agents == ['ACQUIRING_AGENT'] else 'mixed' if agents else None,
            'channel': meta.get('channel'),
            'row': meta.get('row'),
        },
        **{k: kept[k] for k in ('circumstances', 'facts', 'notEstablished', 'observations', 'reactions', 'hypotheses')},
        'identifiers': identifiers(kept, source),
        'style': style(texts),
        'samples': samples,
        'opening': opening,
        'checks': {
            'dropped': dict(dropped),
            'openingFilled': False if not MASK.search(texts[0]) else 'model' if filled else 'digits',
        },
    }
    card['situation'] = brief(card)
    return card


def episode_texts(card: dict, dialogue: dict) -> tuple[str, list[str]]:
    """The episode's first customer message as the log has it, and the customer's messages as the world reads them:
    the filled opening, then the rest of the episode."""
    messages = dialogue['messages'][card['episode']['start'] - 1 :]
    texts = [m['content'] for m in messages if m['role'] == 'user']
    return texts[0], [card['opening'], *texts[1:]]


def uses(test_data: dict | None, raw: str, opening: str) -> bool | None:
    """Whether the mock world contains every identifier-long number (6+ digits: terminal, INN, contract) the filled
    opening gave the customer; None when it gave none. Shorter numbers are amounts, counts or models the world need
    not contain. The world is told to use them; nothing is rewritten here: the code does not know what they mean."""
    given = [n for n in re.findall(r'\d{6,}', opening) if n not in raw]
    if not test_data or not given:
        return None
    text = json.dumps(test_data, ensure_ascii=False)
    return all(n in text for n in given)
