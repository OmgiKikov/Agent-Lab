"""A guided tone-of-voice check: supplied policy, grounded criteria, then the existing conversation judge."""

import asyncio
import hashlib
import re
import uuid

from . import checks, discover, llm, quotes, store, tone_history
from .context import sources
from .jobs import Progress

DRAFT = 'tone-of-voice-criteria.json'
RESULT = checks.result(checks.TONE)  # tone-result.json: its own, beside the accuracy result (discover.RESULT)
KIND = checks.TONE_OF_VOICE  # the kind and id of the communication rules among the sources, the purpose of a result
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


def _code(heading: str) -> str | None:
    """The validator code a heading names: «pronouns», «Лексика и синтаксис: simple_language», «Greeting», «lists:»,
    «emoji2»; None for a heading without one."""
    code = heading.rstrip(':').rsplit(':', 1)[-1].strip().lower()
    return code if re.fullmatch(r'[a-z][a-z0-9_-]*', code) else None


def coded_criteria(source: dict) -> list[dict]:
    """A supplied validator rubric already defines its criteria; retain codes, repeated sections and exceptions.
    Every ## or ### heading ends the section before it. A heading without a code still bounds a section of its own,
    shown under its own words, so its duty never joins the criterion above; a heading over a group of sections has no
    text of its own and is only a boundary."""
    text = source['content']
    section = re.search(r'^# Правила коммуникаций\s*$', text, re.M)
    end = re.search(r'^# Формат ответа\s*$', text, re.M)
    if not section or not end or end.start() <= section.end():
        return []
    rules = text[section.end() : end.start()].strip()
    headings = list(re.finditer(r'^#{2,3}[ \t]+(.+?)[ \t]*$', rules, re.M))
    blocks: dict[str, list[tuple[str, str]]] = {}
    names = dict(RULE_NAMES)
    untitled: dict[str, str] = {}  # the id of a section without a code, by its heading: a repeated one joins it
    for index, heading in enumerate(headings):
        stop = headings[index + 1].start() if index + 1 < len(headings) else len(rules)
        # The quote keeps the passage verbatim; the duty a person reads goes without its «### code» heading.
        passage = (rules[heading.start() : stop].strip(), rules[heading.end() : stop].strip())
        code = _code(heading.group(1))
        if code is None:
            if not passage[1]:
                continue
            title = heading.group(1).strip().rstrip(':')
            code = untitled.setdefault(title, f'section-{len(untitled) + 1}')
            names[code] = title
        blocks.setdefault(code, []).append(passage)
    principles = text.split('## Главные принципы', 1)[-1].split('# Правила коммуникаций', 1)[0].strip()
    return [
        {
            'id': code,
            'name': names.get(code, code),
            'text': '\n'.join(duty for _, duty in parts if duty) or names.get(code, code),
            'quote': ' … '.join(block for block, _ in parts),
            'sourceId': source['id'],
            'observation': 'reply',
            # copy: ok — the model judges by it, and saved checks compare by it (tone_history.criteria_fingerprint)
            'condition': 'Проверять только ответы агента; реплики клиента — контекст.',
            'acceptable': principles,
        }
        for code, parts in blocks.items()
    ]


def policy(name: str, text: str) -> dict:
    text = text.strip()
    if len(text) < 20:
        raise ValueError('В правилах общения меньше 20 символов. Добавьте текст правил.')
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
        raise ValueError('Сначала добавьте правила общения.')
    return found


def rules() -> tuple[dict, dict | None] | None:
    """This agent's rules of communication and the criteria collected from them (None until they are collected), or
    None without rules. Criteria collected from other rules are none of theirs. Read defensively: the list of agents
    reads every agent's."""
    items = sources.load()
    if not isinstance(items, list):
        return None
    found = next((item for item in items if isinstance(item, dict) and item.get('kind') == KIND), None)
    if found is None or not isinstance(found.get('content'), str):
        return None
    draft = store.load(DRAFT)
    if not isinstance(draft, dict) or not isinstance(draft.get('criteria'), list):
        return found, None
    return found, draft if draft.get('sourceSha256') == found.get('sha256') else None


def take(policy: dict, draft: dict | None) -> bool:
    """Another agent's rules of communication and their criteria, with the clarifications people confirmed, become
    this agent's own as a copy; False when it has them already. The agent's code stays. Other rules replace this
    agent's with what was derived from them (store.replace_inputs: its criteria, its tone-of-voice result, a deck from
    them; the saved checks stay); the same rules keep their result, which then belongs to the previous criteria. The
    criteria get a version of their own, so no result of the other agent ever matches them. Rules without criteria
    come alone and never take away criteria collected from the same rules."""
    own = rules()
    same = own is not None and own[0]['content'] == policy['content']
    if same and (draft is None or (own[1] or {}).get('criteria') == draft['criteria']):
        return False
    if not same:
        kept = [item for item in sources.load() if item['kind'] != KIND]
        store.replace_inputs(sources.FILE, [*kept, policy])
    if draft is not None:
        copied = {key: value for key, value in draft.items() if key != 'updatedAt'}
        store.save_tone_draft(copied | {'revision': uuid.uuid4().hex, 'createdAt': store.now()})
    return True


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
        raise ValueError('Сначала загрузите диалоги.')
    progress(message='Собираем критерии из правил общения')
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
        raise ValueError('В уточнении должно быть от 10 до 2000 символов.')
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


def _judged(snapshot: dict) -> tuple[dict, dict, dict]:
    """What a saved check showed the judge and what it said: conversations, criteria as judged, verdicts."""
    conversations = {str(dialogue['id']): dialogue for dialogue in snapshot.get('dialogues') or []}
    criteria = {rule['id']: for_judging(rule) for rule in snapshot.get('criteria') or []}
    verdicts = {
        (str(result['dialogueId']), row['ruleId']): row['status']
        for result in (snapshot.get('result') or {}).get('results') or []
        for row in result.get('rules') or []
    }
    return conversations, criteria, verdicts


def carry_decisions(results: list[dict], criteria: list[dict], dialogues: list[dict]) -> None:
    """A person's latest decision on a criterion of a conversation stays while the verdict is the same and the judge saw
    the same: that conversation, that criterion with its clarifications. It is read from the saved checks, so a check
    in between that could not decide it does not lose it, and clarifying another criterion does not drop it. A new
    export that gives the id to another conversation gets nothing."""
    rows = {(str(result['dialogueId']), row['ruleId']): row for result in results for row in result['rules']}
    shown = {str(dialogue['id']): dialogue for dialogue in dialogues}
    seen = {rule['id']: for_judging(rule) for rule in criteria}
    saved: dict[str, tuple[dict, dict, dict]] = {}
    latest: dict[tuple[str, str], tuple[str | None, str | None]] = {}
    for check_id, dialogue_id, rule_id, decision in store.tone_decisions():
        key = (dialogue_id, rule_id)
        if key in latest or key not in rows:
            continue
        if check_id not in saved:
            saved[check_id] = _judged(store.tone_check(check_id) or {})
        conversations, judged, verdicts = saved[check_id]
        if conversations.get(dialogue_id) == shown.get(dialogue_id) and judged.get(rule_id) == seen.get(rule_id):
            latest[key] = (verdicts.get(key), decision)
    for key, (status, decision) in latest.items():
        if decision and status == rows[key]['status']:
            rows[key]['review'] = decision


async def _judge(dialogues: list[dict], topic: dict, progress: Progress) -> list[dict]:
    results: list[dict] = []

    def done(result: dict) -> None:
        for value in (result, result.get('second')):
            if value and value.get('status') == 'PASS' and any(row['status'] == 'UNKNOWN' for row in value['rules']):
                value['status'] = 'UNMEASURED'
        results.append(result)
        progress(done=len(results), total=len(dialogues), message='Проверяем разговоры')

    await discover.judge_each([(dialogue, topic) for dialogue in dialogues], done)
    order = {str(dialogue['id']): index for index, dialogue in enumerate(dialogues)}
    return sorted(results, key=lambda result: order[str(result['dialogueId'])])


async def assess(criteria: list[dict], count: int, progress: Progress) -> dict:
    source, draft = current_policy(), store.load(DRAFT)
    dialogues = discover.sample(count)
    if not dialogues:
        raise ValueError('Сначала загрузите диалоги.')
    started = store.now()
    topic = {'id': 't1', 'title': checks.TONE_TOPIC, 'rules': criteria, 'dialogueIds': [d['id'] for d in dialogues]}
    progress(done=0, total=len(dialogues), message='Проверяем разговоры')
    results = await _judge(dialogues, {**topic, 'rules': [for_judging(rule) for rule in criteria]}, progress)
    ensure_active()
    previous = store.load(RESULT) or {}
    discover.ensure_answered(results, previous)
    # The live result carries its own answers with the same criteria, as before: a result saved before the history of
    # checks keeps them only in itself. The history then adds what a check in between lost or what another criterion's
    # clarification would have dropped.
    if previous.get('criteriaRevision') == draft['revision']:
        discover.carry_reviews(previous, results)
    carry_decisions(results, criteria, dialogues)
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
        'summary': discover.summarize(results, [topic], len(dialogues)),
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
