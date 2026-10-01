"""A guided tone-of-voice check: supplied policy, grounded criteria, then the existing conversation judge."""

import asyncio
import hashlib
import re
import uuid

from . import discover, llm, quotes, store, tone_history
from .context import sources
from .jobs import Progress

DRAFT = 'tone-of-voice-criteria.json'
KIND = 'tone-of-voice'
PROMPT = """Extract observable tone-of-voice criteria from the supplied communication policy.
Assess only how the agent communicates: politeness, form of address, clarity, empathy, and handling disagreement.
Do not invent a policy or assess factual accuracy, tool use, payments or backend actions.
Every criterion must cite an EXACT meaningful policy substring, preserving conditions and exceptions.
Combine duties sharing the same source passage; do not repeat source quotes.
Return {criteria:[{name,text,quote,condition,acceptable}]} in Russian, at most 20 criteria.
name is a short readable label; text states the duty; condition says when it applies.
acceptable keeps permitted alternatives. Preserve communication prohibitions, including privacy rules.
If no observable communication duties can be grounded, return an empty criteria list."""

RULE_NAMES = {
    'text_volume': 'Объём ответа',
    'readability': 'Структура ответа',
    'pronouns': 'Обращение и голос бренда',
    'simple_language': 'Простой и понятный язык',
    'instruction_tone': 'Тон общения',
    'vocabulary-purity': 'Профессиональная лексика',
    'chat-etiquette': 'Нормы общения',
    'visual-noise': 'Отсутствие визуального шума',
    'basic_marks': 'Типографика и пунктуация',
    'special_characters': 'Пробелы и специальные символы',
    'numbers_currency_contacts': 'Числа, суммы и контакты',
    'lists': 'Оформление списков',
    'standard_writing': 'Названия и установленные написания',
    'safety-compliance': 'Безопасность общения',
}


def coded_criteria(source: dict) -> list[dict]:
    """A supplied validator rubric already defines its criteria; retain codes, repeated sections and exceptions."""
    text = source['content']
    section = re.search(r'^# Правила коммуникаций\s*$', text, re.M)
    end = re.search(r'^# Формат ответа\s*$', text, re.M)
    if not section or not end or end.start() <= section.end():
        return []
    rules = text[section.end() : end.start()].strip()
    headers = list(re.finditer(r'^#{2,3}\s+(?:([^\n:]+):\s*)?([a-z][a-z_-]+)\s*$', rules, re.M))
    blocks: dict[str, list[tuple[str, str]]] = {}
    for index, header in enumerate(headers):
        stop = headers[index + 1].start() if index + 1 < len(headers) else len(rules)
        # The quote keeps the passage verbatim; the duty a person reads goes without its «### code» heading.
        passage = (rules[header.start() : stop].strip(), rules[header.end() : stop].strip())
        blocks.setdefault(header.group(2), []).append(passage)
    principles = text.split('## Главные принципы', 1)[-1].split('# Правила коммуникаций', 1)[0].strip()
    return [
        {
            'id': code,
            'name': RULE_NAMES.get(code, code),
            'text': '\n'.join(duty for _, duty in parts if duty) or RULE_NAMES.get(code, code),
            'quote': ' … '.join(block for block, _ in parts),
            'sourceId': source['id'],
            'observation': 'reply',
            'condition': 'Проверять только ответы агента; реплики клиента — контекст.',
            'acceptable': principles,
        }
        for code, parts in blocks.items()
    ]


def policy(name: str, text: str) -> dict:
    text = text.strip()
    if len(text) < 20:
        raise ValueError('Добавьте правила общения: не менее 20 символов.')
    if len(text) > 50000:
        raise ValueError('В правилах должно быть не более 50 000 символов.')
    return {
        'id': KIND,
        'kind': KIND,
        'name': name,
        'origin': name,
        'content': text,
        'sha256': hashlib.sha256(text.encode()).hexdigest(),
    }


def current_policy() -> dict:
    found = next((source for source in sources.load() if source['kind'] == KIND), None)
    if found is None:
        raise ValueError('Сначала добавьте правила tone of voice.')
    return found


def _criterion(row: dict, index: int, source: dict) -> dict:
    fields = ('name', 'text', 'quote', 'condition', 'acceptable')
    if not isinstance(row, dict) or any(not isinstance(row.get(key), str) for key in fields):
        raise ValueError('criterion needs a name, duty, quote, condition and alternatives')
    if not row['name'].strip() or not row['text'].strip() or not quotes.found(row['quote'], source['content']):
        raise ValueError('criterion must be grounded in the supplied policy')
    return {**row, 'id': f't1r{index}', 'sourceId': source['id'], 'observation': 'reply'}


def _parse(value: dict, source: dict) -> list[dict]:
    rows = value.get('criteria')
    if not isinstance(rows, list) or not 1 <= len(rows) <= 20:
        raise ValueError('Не удалось выделить критерии. Уточните проверяемые требования к общению.')
    criteria = [_criterion(row, index, source) for index, row in enumerate(rows, 1)]
    if len({quotes.normalized(row['quote']) for row in criteria}) != len(criteria):
        raise ValueError('criteria must not repeat the same source quote')
    return criteria


async def prepare(progress: Progress) -> dict:
    source = current_policy()
    if not discover.sample(1):
        raise ValueError('Сначала загрузите разговоры.')
    progress(message='Собираю критерии из ваших правил общения')
    criteria = coded_criteria(source)
    model = None
    if not criteria:
        answer = await llm.structured(PROMPT, {'policy': source['content']}, parse=lambda value: _parse(value, source))
        criteria, model = answer.value, answer.model
    ensure_active()
    return {
        'revision': uuid.uuid4().hex,
        'createdAt': store.now(),
        'sourceSha256': source['sha256'],
        'criteria': criteria,
        'model': model,
    }


def ensure_active() -> None:
    """A dependency swallowing cancellation must not publish a completed result."""
    task = asyncio.current_task()
    if task and task.cancelling():
        raise asyncio.CancelledError


def selection(rule_ids: list[str], revision: str | None = None) -> list[dict]:
    draft = store.load(DRAFT)
    if not draft or draft['sourceSha256'] != current_policy()['sha256']:
        raise ValueError('Сначала соберите критерии по текущим правилам общения.')
    if revision is not None and revision != draft['revision']:
        raise ValueError('Критерии изменились. Обновите страницу перед проверкой.')
    by_id = {rule['id']: rule for rule in draft['criteria']}
    if not rule_ids or len(set(rule_ids)) != len(rule_ids) or not set(rule_ids) <= by_id.keys():
        raise ValueError('Выберите хотя бы один критерий из текущей проверки.')
    return [by_id[key] for key in rule_ids]


def clarified(revision: str, rule_id: str, text: str) -> dict:
    """Only an explicit human confirmation changes the rubric, without touching source evidence."""
    text = text.strip()
    if not 10 <= len(text) <= 2000:
        raise ValueError('Уточнение должно содержать от 10 до 2000 символов.')
    selection([rule_id], revision)
    draft = store.load(DRAFT)
    rule = next(rule for rule in draft['criteria'] if rule['id'] == rule_id)
    entries = rule.setdefault('clarifications', [])
    if text in entries:
        raise ValueError('Такое уточнение уже сохранено.')
    if len(entries) >= 20:
        raise ValueError('Сохранено уже 20 уточнений. Соберите критерии заново из обновлённых правил.')
    entries.append(text)
    draft.update(revision=uuid.uuid4().hex, updatedAt=store.now())
    return draft


def for_judging(rule: dict) -> dict:
    notes = rule.get('clarifications') or []
    if not notes:
        return rule
    return {**rule, 'text': rule['text'] + '\n\nУточнения, подтверждённые человеком:\n' + '\n'.join(notes)}


async def _judge(dialogues: list[dict], topic: dict, progress: Progress) -> list[dict]:
    results: list[dict] = []

    async def one(dialogue: dict) -> None:
        result = await discover.judge_dialogue(dialogue, topic)
        for value in (result, result.get('second')):
            if value and value.get('status') == 'PASS' and any(row['status'] == 'UNKNOWN' for row in value['rules']):
                value['status'] = 'UNMEASURED'
        results.append(result)
        progress(done=len(results), total=len(dialogues), message='Проверяю разговоры по выбранным критериям')

    async with asyncio.TaskGroup() as tasks:
        for dialogue in dialogues:
            tasks.create_task(one(dialogue))
    order = {str(dialogue['id']): index for index, dialogue in enumerate(dialogues)}
    return sorted(results, key=lambda result: order[str(result['dialogueId'])])


async def assess(criteria: list[dict], count: int, progress: Progress) -> dict:
    source, draft = current_policy(), store.load(DRAFT)
    dialogues = discover.sample(count)
    if not dialogues:
        raise ValueError('Сначала загрузите разговоры.')
    started = store.now()
    topic = {'id': 't1', 'title': 'Tone of voice', 'rules': criteria, 'dialogueIds': [d['id'] for d in dialogues]}
    progress(done=0, total=len(dialogues), message='Начинаю проверку tone of voice')
    results = await _judge(dialogues, {**topic, 'rules': [for_judging(rule) for rule in criteria]}, progress)
    ensure_active()
    previous = store.load(discover.RESULT) or {}
    if previous.get('criteriaRevision') == draft['revision']:
        discover.carry_reviews(previous, results)
    return {
        'purpose': KIND,
        'checkId': uuid.uuid4().hex,
        'criteriaRevision': draft['revision'],
        'criteriaFingerprint': tone_history.criteria_fingerprint(criteria, source),
        'datasetFingerprint': tone_history.fingerprint(sorted(dialogues, key=lambda dialogue: str(dialogue['id']))),
        'startedAt': started,
        'finishedAt': store.now(),
        'rulesSince': draft['createdAt'],
        'model': llm.models_used(results),
        'sampled': len(dialogues),
        'unassigned': 0,
        'droppedRules': 0,
        'topics': [topic],
        'results': results,
        'sources': [
            {key: source[key] for key in ('id', 'kind', 'origin', 'sha256')}
            | {'chars': len(source['content']), 'rules': len(criteria)}
        ],
        'summary': discover.summarize(results, [topic]),
    }


def commit(result: dict) -> None:
    ensure_active()
    source = current_policy()
    draft = store.load(DRAFT) or {}
    dialogues = discover.sample(result['sampled'])
    criteria = result['topics'][0]['rules']
    if (
        result['criteriaRevision'] != draft.get('revision')
        or result['criteriaFingerprint'] != tone_history.criteria_fingerprint(criteria, source)
        or result['datasetFingerprint']
        != tone_history.fingerprint(sorted(dialogues, key=lambda dialogue: str(dialogue['id'])))
    ):
        raise ValueError('Материалы проверки изменились. Запустите проверку заново.')
    snapshot = tone_history.snapshot(result, dialogues, criteria, source)
    store.save_tone_check(snapshot)
