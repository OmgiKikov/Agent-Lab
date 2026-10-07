"""The customer of a scenario: one logged episode of the agent's domain read into a card, every item with a quote the
code found in the log. Pure functions; the model's part is roles/card.py.

The customer part of a card is the profile of the synthetic customer, in four blocks:
- context: the channel and how the customer came to the task (episode);
- goal: the task of the episode as the catalog read it, never the trajectory of the conversation;
- knowledge, the prerequisites: what the customer knows, believes or does not know, each with when they say it
  (disclose: in the opening, when it becomes relevant, only when asked), what the log does not establish, what they
  already tried, and what happens when they try something (observations); identifiers get their values from the bank
  the agent sees, when the conversation is played (flows/simulation.customer_details);
- behaviour: reactions as actions to a move of the agent, and the manner counted from their own messages.
The simulator reads only this part (`situation`, rendered here from the fields, never retold by a model); the frozen
criteria of its topic are a separate binding for the judge.
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
# What the customer did in a message that answered the agent: the content comes from their knowledge, not the old chat.
ACTIONS = {
    'answer': 'отвечаешь на вопрос',
    'give_detail': 'уточняешь подробность своей ситуации',
    'dont_know': 'говоришь, что не знаешь',
    'ask_how': 'спрашиваешь, как именно это сделать',
    'ask_meaning': 'переспрашиваешь, что имеется в виду',
    'correct_object': 'поправляешь: тебе нужно другое',
    'report_obstacle': 'говоришь, что так сделать не можешь и что мешает',
    'report_result': 'сообщаешь, что получилось',
    'choose_option': 'выбираешь один из вариантов',
    'decline_handoff': 'не уходишь к оператору и объясняешь задачу здесь',
    'ask_human': 'просишь живого специалиста',
    'restate': 'повторяешь свою задачу',
    'accept': 'принимаешь ответ',
}
# The customer's access to a fact, by the extractor's status; what the agent told is never the customer's own.
ACCESS = {'knows': 'knows', 'masked_in_source': 'knows', 'believes': 'believes', 'does_not_know': 'does_not_know'}
# When the customer says a fact, by where its quote stands (opening, before the episode) or what the extractor saw.
DISCLOSE = {'opening': 'opening', 'before': 'when_relevant', 'later': 'when_relevant', 'on_request': 'on_request'}
# An observation the customer reported trying what the agent suggested is what happens when one tries it; one they
# made before is what they already know.
TRYING = ('instruction', 'inapplicable_instruction')
REPORTING = ('report_result', 'report_obstacle')
ENTRY = {'after_greeting': 'после приветствия', 'after_other_topic': 'после другого вопроса'}
CHANNEL = {'WEB': 'на сайте банка', 'MOBILE': 'в мобильном приложении банка'}
DONE = 'Готово, когда это получилось или у тебя есть способ это сделать, который подходит именно тебе.'

# What an agent's request for an identifier says, besides the words of the profile's identifiers (_asks_for).
IDENTIFYING = r'номер|реквизит|идентификатор|договор|данные'
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
    'handoff_offer': (re.compile(r'оператор|специалист|поддержк|горяч\w* лини|позвон|отделени|менеджер', re.I),),
    'instruction': (STEPS,),
}
TRANSITION = re.compile(r'`\s*`\s*`\s*transition-code\s*([\w-]*)\s*`\s*`\s*`\.?')
WORDS = re.compile(r'\w+')
SHINGLE = 6  # words in a row: a copied phrase, not a shared term


def readable(value: dict) -> dict:
    """The extractor's answer, if a card can be read from it: in Russian, with a name and the episode's start. Whether
    the customer has a task of the agent's domain is the episode reader's decision, not the extractor's: its doubt is
    kept on the card (domainDoubt). A ValueError asks the model again."""
    if FOREIGN.search(json.dumps(value, ensure_ascii=False)):
        raise ValueError('card text switched to another script')
    if not isinstance(value.get('name'), str) or not value['name'].strip():
        raise ValueError('card needs name')
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


def chat(dialogue: dict, agent: dict) -> dict:
    """What the extractor is told about the chat besides its events: its channel and whether agents other than the one
    under test (agent: its profile) took part, when the export names them."""
    meta = dialogue.get('meta') or {}
    agents, own = meta.get('agents') or [], agent['export']['agentCode']
    return {'channel': meta.get('channel'), 'otherAgentsInChat': bool(set(agents) - {own}) if own and agents else None}


def _found(quote: object, text: str, role: str) -> bool:
    """The quote stands in the message (quotes.spoken); a customer's masks are their words, an agent's # and * are
    as often its Markdown."""
    return isinstance(quote, str) and quotes.spoken(quote, text, masks=role == 'user')


def _holds_value(quote: str) -> bool:
    """A quote that carries an identifier itself: five or more digits, or a value the export masked."""
    return len(re.sub(r'\D', '', quote)) >= 5 or bool(MASK.search(quote))


def _asks_for(agent: dict | None) -> re.Pattern:
    """What an agent's request for an identifier of this agent's customers says: a number, details, or the words of
    the profile's identifiers (their stems: «терминала» asks for «номер терминала»)."""
    labels = [x['label'] for x in (agent or {}).get('identifiers') or []]
    stems = {re.escape(word[:5].lower()) for label in labels for word in re.findall(r'\w{3,}', label)}
    return re.compile('|'.join([IDENTIFYING, *sorted(stems)]), re.I)


def _fits(trigger: str, agent_text: str, agent: dict | None = None) -> bool:
    """The agent's message shows what the trigger says it did: a question, a request for an identifier, a handoff,
    steps."""
    needs = TRIGGER_NEEDS.get(trigger, ())
    if trigger == 'identifier_request':
        needs = (ASKS, _asks_for(agent))
    return all(pattern.search(agent_text) for pattern in needs)


def grounded(
    value: dict, messages: list[dict], end: int | None = None, agent: dict | None = None
) -> tuple[dict, Counter]:
    """Only items whose quotes stand in the cited message of the right speaker, within the episode when its end is
    known (end: after it the customer turns to another task); the rest is counted, not kept, and those that cite a
    message after the episode also apart (afterEpisode). agent: the profile of the agent under test, whose
    identifiers the card may hold (none without it)."""
    last = min(end or len(messages), len(messages))

    def said(n: object, quote: object, role: str) -> bool:
        if not isinstance(n, int) or not 1 <= n <= last:
            return False
        return messages[n - 1]['role'] == role and _found(quote, messages[n - 1]['content'], role)

    kept, dropped = {}, Counter()

    def text(item: dict, *fields: str) -> bool:
        return all(isinstance(item.get(f), str) and item[f].strip() for f in fields)

    def acted(x: dict) -> bool:
        x['actions'] = [a for a in x.get('actions') or [] if a in ACTIONS] if isinstance(x.get('actions'), list) else []
        return bool(x['actions'])

    lists = {
        'observations': lambda x: text(x, 'action', 'result')
        and not ABOUT_CHAT.search(x['action'] + ' ' + x['result'])
        and said(x.get('n'), x.get('quote'), 'user'),
        # Learned from the agent: its words or the customer's echo of them.
        'facts': lambda x: text(x, 'text')
        and (
            said(x.get('n'), x.get('quote'), 'user')
            or (x.get('status') == 'learned_from_agent' and said(x.get('n'), x.get('quote'), 'assistant'))
        ),
        'reactions': lambda x: text(x, 'trigger')
        and x['trigger'] in TRIGGERS
        and acted(x)
        and said(x.get('n'), x.get('quote'), 'user')
        and said(x.get('agentN'), x.get('agentQuote'), 'assistant')
        and x['agentN'] < x['n']
        and _fits(x['trigger'], messages[x['agentN'] - 1]['content'], agent),
    }
    for field, valid in lists.items():
        items = [x for x in value.get(field) or [] if isinstance(x, dict)]
        kept[field] = [x for x in items if valid(x)]
        dropped[field] = len(items) - len(kept[field])
        dropped['afterEpisode'] += sum(1 for x in items if isinstance(x.get('n'), int) and x['n'] > last)
    kept['notEstablished'] = [str(x) for x in value.get('notEstablished') or [] if str(x).strip()]
    given = value.get('identifiers') if isinstance(value.get('identifiers'), dict) else {}
    kept['identifiers'] = {}
    for key in (x['key'] for x in (agent or {}).get('identifiers') or []):
        item = given.get(key) if isinstance(given.get(key), dict) else {}  # a malformed one is not established
        status = item.get('status')
        # Knowing it means the customer typed the value: a company's name is not its INN.
        shown = status == 'does_not_know' or _holds_value(str(item.get('quote') or ''))
        cited = said(item.get('n'), item.get('quote'), 'user')
        if status in ('knows', 'masked_in_source', 'does_not_know') and shown and cited:
            kept['identifiers'][key] = {'status': status, 'quote': item['quote']}
        else:
            dropped['identifiers'] += status in ('knows', 'masked_in_source', 'does_not_know')
            kept['identifiers'][key] = {'status': 'not_established'}
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


def identifiers(kept: dict, agent: dict) -> dict:
    """What the customer can say about each identifier of the agent's customers (agent: its profile): from the log
    where it shows. Where the log never settles it, the simulator assumes the customer will look it up when asked
    (basis: assumption): no knowledge is made up either way, and the card keeps that the log did not establish it."""
    result = {}
    for item in agent['identifiers']:
        status = kept['identifiers'][item['key']]['status']
        if status == 'not_established':
            found = {'value': 'looks_up', 'basis': 'assumption'}
        else:
            found = {'value': 'unknown' if status == 'does_not_know' else 'knows', 'basis': 'log'}
        result[item['key']] = {'label': item['label'], **found, 'status': status}
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


def _said(item: dict) -> str:
    """A fact as the customer brings it; what they believe may be wrong."""
    return item['text'] + (' (так ты считаешь, но можешь ошибаться)' if item.get('access') == 'believes' else '')


def _tried(item: dict) -> str:
    return f'уже пробовал: {item["action"]} — {item["result"]}'


def brief(card: dict) -> str:
    """The profile as the simulator reads it: the context, the task, what the customer says when, what they do not
    know, what happens when they try, how they reacted and how they write. Identifiers are not here: their values come
    from the bank the agent sees, beside this text, when the conversation is played."""
    episode, goal = card['episode'], card['goal']
    where = CHANNEL.get(episode.get('channel') or '')
    entry = ENTRY.get(episode.get('entry') or '')
    lines = [
        ' '.join(
            x
            for x in (
                'Ты пишешь в чат поддержки' + (f' {where}.' if where else '.'),
                f'К этому вопросу ты перешёл {entry}.' if entry else '',
            )
            if x
        ),
        f'Твоя задача: {goal["task"]}.' + (f' Речь о: {goal["object"]}.' if goal.get('object') else '') + f' {DONE}',
    ]
    known = [k for k in card['knowledge'] if k['access'] != 'does_not_know']
    before = [o for o in card['observations'] if o['when'] == 'before']

    def block(title: str, items: list[str]) -> None:
        if items:
            lines.append(title + '\n' + '\n'.join(f'- {x}' for x in items))

    block(
        'Уже есть в твоём первом сообщении:',
        [_said(k) for k in known if k['disclose'] == 'opening']
        + [_tried(o) for o in before if o['disclose'] == 'opening'],
    )
    block(
        'Расскажешь сам, когда это станет к месту, не всё сразу:',
        [_said(k) for k in known if k['disclose'] == 'when_relevant']
        + [_tried(o) for o in before if o['disclose'] != 'opening'],
    )
    block('Скажешь, только если спросят:', [_said(k) for k in known if k['disclose'] == 'on_request'])
    block('Не знаешь:', [k['text'] for k in card['knowledge'] if k['access'] == 'does_not_know'])
    block(
        'Из настоящего разговора не известно (если спросят, скажи, что не знаешь или не проверял, не придумывай):',
        card['notEstablished'],
    )
    block(
        'Если агент предложит это сделать, вот что получится:',
        [f'{o["action"]} → {o["result"]}' for o in card['observations'] if o['when'] == 'during'],
    )
    block(
        'Как ты действовал в настоящем разговоре (только если агент сделает то же):',
        [
            f'если {TRIGGERS[r["trigger"]]}: {" и ".join(ACTIONS[a] for a in r["actions"])}'
            + (f' («{"»; «".join(r["reveals"])}»)' if r['reveals'] else '')
            for r in card['reactions']
        ],
    )
    lines.append(_manner(card['style'], card.get('samples') or []))
    return '\n'.join(lines)


def starts(messages: list[dict], start: object) -> bool:
    """Whether an episode can start at this message: a customer's one of the conversation."""
    return isinstance(start, int) and 1 <= start <= len(messages) and messages[start - 1]['role'] == 'user'


def _unmasked(text: str, rng: random.Random) -> tuple[str, int]:
    """A customer-facing text with no mask left: short masked digits as fictional digits of the same length; a long
    masked number (an identifier: its value comes from the bank the agent sees) and hidden text (*) as «…»."""
    found = MASK.findall(text)

    def filled(match: re.Match) -> str:
        run = match.group()
        return ''.join(rng.choice('123456789') for _ in run) if set(run) == {'#'} and len(run) < 5 else '…'

    return MASK.sub(filled, text), len(found)


def customer(value: dict, dialogue: dict, agent: dict, episode: dict | None = None) -> dict:
    """The customer part of a card, the profile, from the extractor's answer (readable) about the agent under test
    (agent: its profile). episode: the catalog's reading of the conversation (start, end, task, object): the card
    describes the episode its business scenario was given for, whatever the extractor said, its goal is the episode's
    task, and nothing after its end (the customer turns to another task) is the card's evidence or manner. The items
    are those the code found in the log; when each fact is said follows from where its quote stands, and what a
    reaction reveals from the facts said in the same message. Masks are filled in every text the customer reads."""
    messages, source = dialogue['messages'], str(dialogue['id'])
    meta = dialogue.get('meta') or {}
    agents = meta.get('agents') or []
    episode = episode or {}
    start, end = episode.get('start'), episode.get('end')
    kept, dropped = grounded(value, messages, end, agent)
    said = value['episode']['start']
    if starts(messages, start):
        dropped['episode'] = int(said != start)
    elif starts(messages, said):
        start = said
    else:
        start, dropped['episode'] = 1, 1
    end = end if isinstance(end, int) and start <= end <= len(messages) else len(messages)
    rng, masks = random.Random(f'{SEED}:text:{source}'), 0

    def clean(text: str) -> str:
        nonlocal masks
        text, found = _unmasked(text.strip(), rng)
        masks += found
        return text

    def disclose(n: int, label: object) -> str:
        if n == start:
            return 'opening'
        return 'when_relevant' if n < start or label == 'opening' else DISCLOSE.get(str(label), 'when_relevant')

    knowledge = []
    for fact in kept['facts']:
        if fact.get('status') not in ACCESS:
            # The old agent's words are not what this customer brings; a fact of no known status is not a fact.
            dropped['fromAgent' if fact.get('status') == 'learned_from_agent' else 'facts'] += 1
            continue
        access = ACCESS[fact['status']]
        knowledge.append(
            {
                'text': clean(fact['text']),
                'access': access,
                'disclose': disclose(fact['n'], fact.get('said')),
                'n': fact['n'],
                'quote': fact['quote'],
            }
        )
    trying = {r['n'] for r in kept['reactions'] if r['trigger'] in TRYING and set(REPORTING) & set(r['actions'])}
    observations = [
        {
            'action': clean(o['action']),
            'result': clean(o['result']),
            'when': 'during' if o['n'] in trying else 'before',
            'disclose': disclose(o['n'], None),
            'n': o['n'],
            'quote': o['quote'],
        }
        for o in kept['observations']
    ]
    reactions = []
    for r in kept['reactions']:
        reveals = [k['text'] for k in knowledge if k['n'] == r['n'] and k['access'] != 'does_not_know']
        reveals += [_tried(o) for o in observations if o['n'] == r['n'] and o['when'] == 'before']
        reactions.append(
            {key: r[key] for key in ('trigger', 'actions', 'agentN', 'agentQuote', 'n', 'quote')} | {'reveals': reveals}
        )
    # What the log leaves open about an identifier is the identifier's own (identifiers): its value comes from the bank.
    labels = [_stems(x['label']) for x in agent['identifiers']]
    established = [x for x in kept['notEstablished'] if not any(label and label <= _stems(x) for label in labels)]
    dropped['notEstablished'] += len(kept['notEstablished']) - len(established)
    texts = [m['content'] for m in messages[start - 1 : end] if m['role'] == 'user']
    quoted = {x['quote'] for x in kept['reactions']}
    samples = [t for t in texts[1:] if not MASK.search(t) and len(t) <= 160 and t not in quoted][:2]
    filled = _filled(texts[0], value.get('openingFilled'))
    opening = filled or _digits(texts[0], source)
    card = {
        'name': value['name'].strip(),
        'goal': {
            'task': str(episode.get('task') or value['name']).strip().rstrip('.'),
            'object': str(episode.get('object') or '').strip().rstrip('.'),
        },
        'episode': {
            'start': start,
            'end': end,
            'entry': (value.get('episode') or {}).get('entry'),
            'scope': 'agent_only' if agents == [agent['export']['agentCode']] else 'mixed' if agents else None,
            'channel': meta.get('channel'),
            'row': meta.get('row'),
        },
        'knowledge': knowledge,
        'notEstablished': [clean(x) for x in established],
        'observations': observations,
        'reactions': reactions,
        'identifiers': identifiers(kept, agent),
        'style': style(texts),
        'samples': samples,
        'opening': opening,
        'checks': {
            'dropped': dict(dropped),
            'openingFilled': False if not MASK.search(texts[0]) else 'model' if filled else 'digits',
            'masksFilled': masks,
            # The extractor's doubt that the customer has a task of the domain: the reader decided; kept for review.
            'domainDoubt': str(value.get('domainDoubt') or '').strip() or None,
        },
    }
    card['situation'] = brief(card)
    return card


def _shingles(text: str) -> set[tuple[str, ...]]:
    words = WORDS.findall(text.lower())
    return {tuple(words[i : i + SHINGLE]) for i in range(len(words) - SHINGLE + 1)}


def _stems(text: str) -> set[str]:
    """The content words of a text by their first five letters: «терминала» is «терминал»."""
    return {word[:5] for word in WORDS.findall(text.lower()) if len(word) >= 5}


def audit(card: dict, dialogue: dict, criteria: list[dict]) -> dict:
    """What the code checks in the text the simulator reads: no phrase of the old agent's replies in the episode and
    none of the judge's criteria (SHINGLE words in a row), and no fact the customer said only later already in their
    goal. Each is what was found, at most a few; empty is clean."""
    episode, told = card['episode'], _shingles(card['situation'])
    replies = [m['content'] for m in dialogue['messages'][episode['start'] - 1 : episode['end']] if m['role'] != 'user']
    rules = [text for c in criteria for text in (c['text'], c['quote'])]
    goal = _stems(f'{card["goal"]["task"]} {card["goal"]["object"]}')

    def copied(texts: list[str]) -> list[str]:
        return sorted({' '.join(phrase) for text in texts for phrase in _shingles(text) & told})[:3]

    def ahead(text: str) -> bool:
        stems = _stems(text)
        return bool(stems) and len(stems & goal) * 2 >= len(stems)

    later = [k['text'] for k in card['knowledge'] if k['disclose'] != 'opening' and k['access'] != 'does_not_know']
    return {
        'agentWords': copied(replies),
        'criteriaWords': copied(rules),
        'goalAhead': [text for text in later if ahead(text)],
    }


def episode_texts(card: dict, dialogue: dict) -> tuple[str, list[str]]:
    """The episode's first customer message as the log has it, and the customer's messages as the world reads them:
    the filled opening, then the rest of the episode."""
    episode = card['episode']
    messages = dialogue['messages'][episode['start'] - 1 : episode.get('end') or len(dialogue['messages'])]
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
