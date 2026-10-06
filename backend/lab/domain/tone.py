"""Tone of voice: criteria from a person's rules of communication, as the judge reads them, and the record of a check.

A validator rubric in the rules (# Правила коммуникаций, a section per code) defines its criteria itself
(coded_criteria); other rules get theirs from a model (roles.tone). A clarification people confirmed is part of the
criterion the judge reads (for_judging) and stays with the same words of the rules (kept_clarifications). Pure
functions: nothing is read or stored.
"""

import hashlib
import re

from . import accuracy, quotes
from .checks import TONE_OF_VOICE as KIND
from .comparison import comparison, dataset_fingerprint, evaluation_fingerprint, fingerprint

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
            # The model judges by it, and saved checks compare by it (criteria_fingerprint).
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


def kept_clarifications(criteria: list[dict], previous: dict | None, source: dict) -> list[dict]:
    """The clarifications people confirmed stay with a criterion collected again from the same rules when its quote is
    the same: the exception a person described still applies to the same words of the rules. Criteria of other rules
    start without them."""
    if not isinstance(previous, dict) or previous.get('sourceSha256') != source['sha256']:
        return criteria
    confirmed = {
        quotes.normalized(rule['quote']): list(rule['clarifications'])
        for rule in previous.get('criteria') or []
        if rule.get('clarifications')
    }
    return [
        rule | {'clarifications': confirmed[key]} if (key := quotes.normalized(rule['quote'])) in confirmed else rule
        for rule in criteria
    ]


def for_judging(rule: dict) -> dict:
    notes = rule.get('clarifications') or []
    if not notes:
        return rule
    return {**rule, 'text': rule['text'] + '\n\nУточнения, подтверждённые человеком:\n' + '\n'.join(notes)}


def judged(snapshot: dict) -> tuple[dict, dict, dict]:
    """What a saved check showed the judge and what it said: conversations, criteria as judged, verdicts."""
    conversations = {str(dialogue['id']): dialogue for dialogue in snapshot.get('dialogues') or []}
    criteria = {rule['id']: for_judging(rule) for rule in snapshot.get('criteria') or []}
    verdicts = {
        (str(result['dialogueId']), row['ruleId']): (row['status'], row.get('agentQuote'))
        for result in (snapshot.get('result') or {}).get('results') or []
        for row in result.get('rules') or []
    }
    return conversations, criteria, verdicts


def criteria_fingerprint(criteria: list[dict], source: dict) -> str:
    return fingerprint({'source': source['sha256'], 'criteria': sorted(criteria, key=lambda rule: rule['id'])})


def snapshot(
    result: dict, dialogues: list[dict], criteria: list[dict], source: dict, export: dict, previous: dict | None
) -> dict:
    """The record of a finished check in the history: its line, how it stands to the check saved before it, and the
    evidence behind it: the conversations, the criteria and the rules they came from. export: the export the
    conversations came from, as a result keeps it (storage.exports.line): its file and how many it had."""
    check = {
        'id': result['checkId'],
        'finishedAt': result['finishedAt'],
        'criteriaRevision': result['criteriaRevision'],
        'criteriaFingerprint': result['criteriaFingerprint'],
        'datasetFingerprint': dataset_fingerprint(dialogues),
        'evaluationFingerprint': evaluation_fingerprint(result),
        'file': export.get('file'),
        'total': export.get('total') or 0,
        'export': accuracy.named(export),
        'sampled': result['sampled'],
        'summary': {key: result['summary'][key] for key in ('measured', 'passed', 'failed', 'unmeasured')},
        'model': result['model'],
    }
    check['comparison'] = comparison(check, previous)
    return {
        'check': check,
        'result': result,
        'dialogues': dialogues,
        'criteria': criteria,
        'policy': {'name': source.get('name') or source['origin'], 'content': source['content']},
        'reviewSemantics': 'at-completion',
    }
