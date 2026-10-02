"""Test cards: customers of real conversations, chosen into three sets.

A card is the customer of one logged acquiring episode: the task, what the customer knows and how they know it,
what they saw, how they write and how they reacted to the agent, every item with a quote the code found in the log.
The simulator reads only this customer part (`situation`, rendered here from the fields); the frozen criteria of
its topic are a separate binding for the judge. Test data for the mocked bank systems is built per card.

Sets are never averaged together:
- representative: a simple random sample of the imported episodes, independent of verdicts; each stands for N/n;
- regression: conversations where the audit found a failure, up to two per topic;
- stress: rare combinations from the export's service columns; their prevalence is not the point.
"""

import asyncio
import hashlib
import json
import random
import re
import statistics
from collections import Counter
from collections.abc import Callable, Sequence

from . import discover, llm, logs, quotes, store, tone
from .agents import world
from .context import sources
from .prompts import CARD

DECK = 'cards.json'
LIMIT = 30
REPRESENTATIVE = 24
STRESS = 6
SEED = 20261002  # the same sample for the same logs
SETS = {'representative': 'Представительный набор', 'regression': 'Ошибка из лога', 'stress': 'Стрессовый набор'}
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
FOREIGN = re.compile(r'[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]')  # the model sometimes slips into CJK
# An observation is the customer's own try in the world; one about the chat or the agent is the old agent's answer.
ABOUT_CHAT = re.compile(r'агент|бот|чат|ассистент|оператор|ответил|отказал|посоветовал|сказали', re.I)
TRANSITION = re.compile(r'`\s*`\s*`\s*transition-code\s*([\w-]*)\s*`\s*`\s*`\.?')
RARE = {
    'Четыре и больше реплик клиента': lambda d: sum(m['role'] == 'user' for m in d['messages']) >= 4,
    'Агент эквайринга вернул 202-1 или 202-7': lambda d: bool(
        {'202_1', '202_7'} & set((d.get('meta') or {}).get('acquiringStatuses') or [])
    ),
    'В чате были другие агенты, кроме общего ассистента': lambda d: bool(
        set((d.get('meta') or {}).get('agents') or []) - {'ACQUIRING_AGENT', 'AGENT_GIGACHAT'}
    ),
}
# Applies to every scenario: instructions must come from the knowledge base, not be invented.
FOLLOWS_KNOWLEDGE = {
    'id': 'g-knowledge',
    'name': 'Не выдумывает инструкции',
    'text': (
        'Ответ агента опирается на статьи базы знаний: шаги, разделы, сроки и условия совпадают со статьёй '
        'и не выдуманы.'
    ),
    'condition': 'Когда агент даёт инструкцию или сообщает факты.',
    'acceptable': 'Уточняющий вопрос; «Не могу помочь, информация отсутствует», если в статьях нет ответа.',
    'quote': 'Используй ТОЛЬКО информацию из контекста.',
    'observation': 'knowledge',
}
# Applies to every scenario: the agent must answer the question that was asked.
ANSWERS_THE_QUESTION = {
    'id': 'g-answer',
    'name': 'Отвечает на заданный вопрос',
    'text': (
        'Каждый ответ агента по существу вопроса клиента: инструкция именно для его задачи '
        'или уточнение недостающего, без ответов на другую тему.'
    ),
    'condition': 'Всегда, когда агент отвечает клиенту.',
    'acceptable': (
        'Уточняющий вопрос по существу; «Не могу помочь, информация отсутствует», если ответа действительно нет.'
    ),
    'quote': 'Твоя главная задача — найти и чётко выдать инструкции для самостоятельного выполнения клиентом',
}


def deck() -> list[dict]:
    return (store.load(DECK) or {}).get('cards') or []


def remember_openings(openings: dict[str, dict[str, str]]) -> None:
    """Keep the openings rewritten for customer types (simulate.prepare_openings) in the cards."""
    value = store.load(DECK) or {}
    for card in value.get('cards') or []:
        card.setdefault('openings', {}).update(openings.get(card['id'], {}))
    store.save(DECK, value)


def _parse_card(value: dict) -> dict:
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


def pick(analysis: dict) -> list[tuple[dict, dict, str]]:
    """Regression: per topic, up to two conversations where the agent failed."""
    by_id = {str(d['id']): d for d in logs.load()}
    rounds = [[], []]  # 1st and 2nd failure of every topic
    for topic in analysis['topics']:
        if not any(r['observation'] == 'reply' for r in topic['rules']):
            continue
        failed = [
            r
            for r in analysis['results']
            if r['topicId'] == topic['id'] and r['status'] == 'FAIL' and str(r['dialogueId']) in by_id
        ]
        for n in range(min(2, len(failed))):
            rounds[n].append((topic, by_id[str(failed[n]['dialogueId'])], SETS['regression']))
    return [chosen for group in rounds for chosen in group][:LIMIT]


def representative(dialogues: list[dict], size: int = REPRESENTATIVE) -> tuple[list[dict], dict]:
    """A simple random sample of the imported episodes, whatever the judge said about them."""
    pool = sorted(dialogues, key=lambda d: str(d['id']))
    chosen = random.Random(SEED).sample(pool, min(size, len(pool)))
    manifest = {'method': 'простая случайная выборка', 'population': len(pool), 'sample': len(chosen), 'seed': SEED}
    manifest['weight'] = round(len(pool) / len(chosen), 2) if chosen else None
    return chosen, manifest


def stress(dialogues: list[dict], taken: set[str], size: int = STRESS) -> tuple[list[dict], dict]:
    """Rare combinations of the export's service columns, in turn per condition; their share is reported, not used."""
    rng = random.Random(SEED)
    found = {name: [d for d in dialogues if test(d)] for name, test in RARE.items()}
    queues = {name: rng.sample(items, len(items)) for name, items in found.items()}
    chosen, why = [], {}
    while len(chosen) < size and any(queues.values()):
        for name, queue in queues.items():
            while queue and str(queue[0]['id']) in taken:
                queue.pop(0)
            if queue and len(chosen) < size:
                dialogue = queue.pop(0)
                taken.add(str(dialogue['id']))
                chosen.append(dialogue)
                why[str(dialogue['id'])] = name
    shares = {name: f'{len(items)} из {len(dialogues)}' for name, items in found.items()}
    return chosen, {'conditions': shares, 'because': why, 'weight': None, 'note': 'частота в проде не оценивается'}


def general_rules(analysis: dict) -> list[dict]:
    """Rules the planner attached to three or more topics: they apply to every scenario."""
    by_quote = {}
    for topic in analysis['topics']:
        for rule in topic['rules']:
            if rule['observation'] == 'reply':
                by_quote.setdefault(quotes.normalized(rule['quote']), []).append((topic['id'], rule))
    return [items[0][1] for items in by_quote.values() if len({t for t, _ in items}) >= 3]


def _events(dialogue: dict) -> list[dict]:
    """The chat as the card extractor reads it: numbered events, interface codes apart from the agent's words."""
    events = []
    for n, message in enumerate(dialogue['messages'], 1):
        text = message['content']
        codes = [code for code in TRANSITION.findall(text) if code]
        event = {'n': n, 'role': 'CUSTOMER' if message['role'] == 'user' else 'AGENT', 'text': TRANSITION.sub('', text)}
        if codes:
            event['interface'] = codes
        events.append(event)
    return events


def _found(quote: object, text: str) -> bool:
    if not isinstance(quote, str):
        return False
    needle = re.sub(r'\s+', '', quotes.normalized(quote))
    return sum(ch.isalnum() for ch in needle) >= 2 and needle in re.sub(r'\s+', '', quotes.normalized(text))


def _grounded(value: dict, messages: list[dict]) -> tuple[dict, Counter]:
    """Only items whose quotes stand in the cited message of the right speaker; the rest is counted, not kept."""

    def said(n: object, quote: object, role: str) -> bool:
        if not isinstance(n, int) or not 1 <= n <= len(messages):
            return False
        return messages[n - 1]['role'] == role and _found(quote, messages[n - 1]['content'])

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
        and x['agentN'] < x['n'],
    }
    for field, valid in lists.items():
        items = [x for x in value.get(field) or [] if isinstance(x, dict)]
        kept[field] = [x for x in items if valid(x)]
        dropped[field] = len(items) - len(kept[field])
    hypotheses = [
        x
        for x in value.get('hypotheses') or []
        if isinstance(x, dict) and text(x, 'trigger', 'response') and x['trigger'] in TRIGGERS
    ]
    kept['hypotheses'] = [{'trigger': x.get('trigger'), 'response': x['response']} for x in hypotheses[:2]]
    kept['notEstablished'] = [str(x) for x in value.get('notEstablished') or [] if str(x).strip()]
    for name in IDENTIFIERS:
        item = (value.get('identifiers') or {}).get(name) or {}
        status = item.get('status') if isinstance(item, dict) else None
        if status in ('knows', 'masked_in_source', 'does_not_know') and said(item.get('n'), item.get('quote'), 'user'):
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


async def build_card(topic: dict, dialogue: dict, sets: Sequence[str], general: Sequence[dict] = ()) -> dict:
    meta = dialogue.get('meta') or {}
    agents = meta.get('agents') or []
    chat = {'channel': meta.get('channel'), 'otherAgentsInChat': bool(set(agents) - {'ACQUIRING_AGENT'})}
    payload = {'topic': topic['title'], 'chat': chat, 'events': _events(dialogue)}
    answer = await llm.structured(CARD, payload, parse=_parse_card)
    value, messages = answer.value, dialogue['messages']
    source = str(dialogue['id'])
    base = {
        'topic': topic['title'],
        'topicId': topic['id'],
        'sets': list(sets),
        'origin': SETS[sets[0]],
        'sourceDialogueId': source,
        'id': hashlib.sha256(f'{source}:{topic["title"]}'.encode()).hexdigest()[:12],
        'model': answer.model,
    }
    if value.get('eligible') is False:
        return {**base, 'eligible': False, 'reason': str(value.get('ineligibleReason') or '')}
    kept, dropped = _grounded(value, messages)
    start = value['episode']['start']
    if not 1 <= start <= len(messages) or messages[start - 1]['role'] != 'user':
        start, dropped['episode'] = 1, 1
    for fact in kept['facts']:
        # When it was said follows from where its quote stands, not from the model's label.
        if fact['n'] < start:
            fact['said'] = 'before'
        elif fact['n'] == start:
            fact['said'] = 'opening'
        elif fact.get('said') == 'opening':
            fact['said'] = 'later'
    customer = [m['content'] for m in messages[start - 1 :] if m['role'] == 'user']
    quoted = {x['quote'] for x in kept['reactions']}
    samples = [t for t in customer[1:] if not MASK.search(t) and len(t) <= 160 and t not in quoted][:2]
    filled = _filled(customer[0], value.get('openingFilled'))
    opening = filled or _digits(customer[0], source)
    card = {
        **base,
        'eligible': True,
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
        'style': style(customer),
        'samples': samples,
        'opening': opening,
        'checks': {
            'dropped': dict(dropped),
            'openingFilled': 'model' if filled else 'digits' if opening != customer[0] else False,
        },
    }
    card['situation'] = brief(card)
    card['criteria'] = _criteria(topic, general)
    try:
        card['world'] = await world.build(card['situation'], customer)
    except llm.ModelError:
        card['world'] = None
    return card


def _criteria(topic: dict, general: Sequence[dict]) -> list[dict]:
    rules = [r for r in topic['rules'] if r['observation'] in ('reply', 'tool')]
    seen = {quotes.normalized(r['quote']) for r in rules}
    rules += [r for r in general if quotes.normalized(r['quote']) not in seen]
    prompts = '\n'.join(source['content'] for source in sources.load())
    rules += [rule for rule in (ANSWERS_THE_QUESTION, FOLLOWS_KNOWLEDGE) if quotes.found(rule['quote'], prompts)]
    rules = [tone.for_judging(rule) for rule in rules]
    return [
        {
            'id': r['id'],
            'name': r.get('name', ''),
            'text': r['text'],
            'condition': r.get('condition', ''),
            'acceptable': r.get('acceptable', ''),
            'quote': r['quote'],
            'observation': r.get('observation', 'reply'),
            **({'clarifications': list(r['clarifications'])} if r.get('clarifications') else {}),
        }
        for r in rules
    ]


async def _topics(analysis: dict, dialogues: list[dict]) -> dict[str, dict]:
    """The audit's topic of each conversation; those the audit did not sample are sorted into its topics."""
    topics = {t['id']: t for t in analysis['topics']}
    known = {str(r['dialogueId']): topics[r['topicId']] for r in analysis['results'] if r['topicId'] in topics}
    new = [d for d in dialogues if str(d['id']) not in known]
    if new:
        for topic in await discover.keep_topics(analysis, new):
            known.update({str(i): topics.get(topic['id'], topic) for i in topic['dialogueIds']})
    return known


async def run(progress: Callable[..., None] = lambda **_: None, size: int = REPRESENTATIVE) -> dict:
    analysis = store.load(discover.RESULT)
    if not analysis:
        raise RuntimeError('Сначала оцените диалоги')
    if analysis.get('purpose') == tone.KIND:
        draft = store.load(tone.DRAFT) or {}
        if draft.get('revision') != analysis.get('criteriaRevision'):
            raise RuntimeError(
                'Критерии общения изменились. Сначала повторите проверку разговоров, затем соберите сценарии.'
            )
    dialogues = logs.load()
    chosen: dict[str, tuple[dict, list[str]]] = {}
    for _, dialogue, _ in pick(analysis):
        chosen.setdefault(str(dialogue['id']), (dialogue, []))[1].append('regression')
    sample, manifest = representative(dialogues, size)
    manifests = {'representative': manifest}
    for dialogue in sample:
        chosen.setdefault(str(dialogue['id']), (dialogue, []))[1].append('representative')
    rare, manifests['stress'] = stress(dialogues, set(chosen))
    for dialogue in rare:
        chosen.setdefault(str(dialogue['id']), (dialogue, []))[1].append('stress')
    if not chosen:
        raise RuntimeError('Нет разговоров для сборки сценариев')
    progress(stage='cards', done=0, total=len(chosen), message='Распределяю разговоры по темам')
    topic_of = await _topics(analysis, [dialogue for dialogue, _ in chosen.values()])
    plan = [(topic_of[i], dialogue, sets) for i, (dialogue, sets) in chosen.items() if topic_of.get(i, {}).get('rules')]
    unsorted = [
        {'eligible': False, 'sets': sets, 'sourceDialogueId': i, 'reason': 'не отнесён к теме с правилами'}
        for i, (_, sets) in chosen.items()
        if not topic_of.get(i, {}).get('rules')
    ]
    general = general_rules(analysis)
    done = []

    async def one(topic: dict, dialogue: dict, sets: list[str]) -> dict:
        card = await build_card(topic, dialogue, sets, general)
        done.append(card)
        progress(
            stage='cards', done=len(done), total=len(plan), message=f'Готово сценариев: {len(done)} из {len(plan)}'
        )
        return card

    progress(stage='cards', done=0, total=len(plan), message='Собираю сценарии')
    try:
        async with asyncio.TaskGroup() as tasks:
            pending = [tasks.create_task(one(*item)) for item in plan]
    except* llm.ModelError as errors:
        raise llm.ModelError(str(errors.exceptions[0])) from errors
    return _deck([task.result() for task in pending] + unsorted, manifests)


def _deck(built: list[dict], manifests: dict) -> dict:
    """Eligible cards and each set's manifest: its cards, and the sampled episodes that had no acquiring task."""
    deck = [card for card in built if card['eligible']]
    for key, label in SETS.items():
        manifest = manifests.setdefault(key, {})
        manifest['label'] = label
        manifest['cardIds'] = [card['id'] for card in deck if key in card['sets']]
        manifest['excluded'] = [
            {'dialogueId': card['sourceDialogueId'], 'reason': card['reason']}
            for card in built
            if not card['eligible'] and key in card['sets']
        ]
    for card in deck:
        if 'representative' in card['sets']:
            card['weight'] = manifests['representative']['weight']
    return {'cards': deck, 'sets': manifests}
