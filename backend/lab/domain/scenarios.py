"""Scenarios: business situations built from the errors one check found in the real conversations, as tests.

A scenario (a card) is a situation for the synthetic customer taken from a real conversation, its frozen criteria (the
grounded rules of its topic, observable in the agent's replies or its system calls) and its test data for the mocked
bank's systems. A card from an error names the criteria the agent failed in that conversation (reproduces): the
scenario is a test of that error. Its result in every run
of the deck's check stands beside the others; nothing here says whether the agent got better or worse. Pure functions.
"""

import hashlib
import json
from collections.abc import Collection, Sequence

from . import quotes
from .metric import FINISHED
from .personas import DEFAULT
from .tone import for_judging

LIMIT = 30
PER_ERROR = 2  # conversations per criterion the agent failed, and controls per topic
# Why a card exists: an error the check found in a real conversation, or a conversation without one (a control).
FROM_LOG, COVERAGE = 'Ошибка из лога', 'Покрытие темы'
# Applies to every scenario: instructions must come from the knowledge base, not be invented.
FOLLOWS_KNOWLEDGE = {
    'id': 'g-knowledge',
    'name': 'Не выдумывает инструкции',
    'text': (
        'Ответ агента опирается на статьи базы знаний: шаги, разделы, сроки и условия совпадают со статьёй '
        'и не выдуманы.'
    ),
    'condition': 'Когда агент даёт инструкцию или сообщает факты.',
    'acceptable': 'Уточняющий вопрос. Или «Не могу помочь, информация отсутствует», если в статьях нет ответа.',
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
        'Уточняющий вопрос по существу. Или «Не могу помочь, информация отсутствует», если ответа действительно нет.'
    ),
    'quote': 'Твоя главная задача — найти и чётко выдать инструкции для самостоятельного выполнения клиентом',
}


def failed_in(result: dict) -> list[str]:
    """The criteria the agent failed in one conversation of a check's result, in the order of its verdicts."""
    return [row['ruleId'] for row in result.get('rules') or [] if row.get('status') == 'FAIL' and row.get('ruleId')]


def pick(analysis: dict, known: Collection[str]) -> list[tuple[dict, str, str, list[str]]]:
    """The conversations to build scenarios from, with the criteria the agent failed in each. Per topic, every
    criterion the agent failed gets its own conversation, the most frequent error first, then a conversation without
    an error (a control); then every criterion its second conversation, then the second control. A conversation is
    used once and keeps every criterion it failed. The rounds run across all topics, so a cut at LIMIT keeps one
    scenario per error before any second one: tone of voice, one topic, was capped at two errors and two controls.
    known: the conversations of the export; each pick names its conversation by id."""
    topics = []
    for topic in analysis['topics']:
        if not any(r['observation'] == 'reply' for r in topic['rules']):
            continue
        results = [r for r in analysis['results'] if r['topicId'] == topic['id'] and str(r['dialogueId']) in known]
        failing = {
            rule['id']: [r for r in results if r['status'] == 'FAIL' and rule['id'] in failed_in(r)]
            for rule in topic['rules']
            if rule['observation'] in ('reply', 'tool')
        }
        ordered = sorted((found for found in failing.values() if found), key=len, reverse=True)
        # A conversation checked without an error first; one the model could not check only when none is left.
        controls = [r for status in ('PASS', 'UNMEASURED') for r in results if r['status'] == status]
        topics.append((topic, ordered, controls))
    used: set[str] = set()
    picked = []
    for n in range(PER_ERROR):
        for topic, ordered, _ in topics:
            for found in ordered:
                result = next((r for r in found if str(r['dialogueId']) not in used), None)
                if result is not None:
                    used.add(str(result['dialogueId']))
                    picked.append((topic, str(result['dialogueId']), FROM_LOG, failed_in(result)))
        for topic, _, controls in topics:
            if n < len(controls):
                picked.append((topic, str(controls[n]['dialogueId']), COVERAGE, []))
    return picked[:LIMIT]


def general_rules(analysis: dict) -> list[dict]:
    """Rules the planner attached to three or more topics: they apply to every scenario."""
    by_quote = {}
    for topic in analysis['topics']:
        for rule in topic['rules']:
            if rule['observation'] == 'reply':
                by_quote.setdefault(quotes.normalized(rule['quote']), []).append((topic['id'], rule))
    return [items[0][1] for items in by_quote.values() if len({t for t, _ in items}) >= 3]


def criteria(topic: dict, general: Sequence[dict], prompts: str) -> list[dict]:
    """The criteria a scenario of this topic is judged by, frozen in its card: the topic's rules observable in replies
    or system calls, the general ones, and the two that apply to every scenario when the agent's prompts say them (the
    words of the prompts); clarifications people confirmed are part of what the judge reads."""
    rules = [r for r in topic['rules'] if r['observation'] in ('reply', 'tool')]
    seen = {quotes.normalized(r['quote']) for r in rules}
    rules += [r for r in general if quotes.normalized(r['quote']) not in seen]
    rules += [rule for rule in (ANSWERS_THE_QUESTION, FOLLOWS_KNOWLEDGE) if quotes.found(rule['quote'], prompts)]
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
        for r in map(for_judging, rules)
    ]


def card(
    topic: dict,
    dialogue: dict,
    situation: tuple[str, str],
    criteria: list[dict],
    origin: str,
    reproduces: Sequence[str],
    world: dict | None,
) -> dict:
    """The card of one conversation: situation is the scenario's name and situation. reproduces: the criteria the agent
    failed in it (pick); the card keeps the ones it checks, so a criterion the scenario cannot observe is never said to
    be reproduced by it. Its id is the hash of its content."""
    name, text = situation
    checked = {criterion['id'] for criterion in criteria}
    found = {
        'topic': topic['title'],
        'topicId': topic['id'],
        'name': name.strip(),
        'situation': text.strip(),
        'opening': next(m['content'] for m in dialogue['messages'] if m['role'] == 'user'),
        'criteria': criteria,
        'origin': origin,
        'sourceDialogueId': str(dialogue['id']),
        'reproduces': list(dict.fromkeys(rule_id for rule_id in reproduces if rule_id in checked)),
        'world': world,
    }
    found['id'] = hashlib.sha256(json.dumps(found, ensure_ascii=False, sort_keys=True).encode()).hexdigest()[:12]
    return found


def _named(criterion: dict, fallback: str) -> str:
    """A criterion's short name; one without a name is named by what it requires."""
    return (criterion.get('name') or '').strip() or criterion.get('text') or fallback


def reproduced(card: dict, source: dict | None) -> list[dict]:
    """The criteria the scenario reproduces, with the agent's words from its real conversation (source: that
    conversation in the current result of the deck's check). A card built before cards named them reproduces what its
    conversation failed in that result, when it came from an error. The words come only from a verdict that is still
    an error there."""
    criteria = {criterion['id']: criterion for criterion in card.get('criteria') or []}
    rows = {row.get('ruleId'): row for row in (source or {}).get('rules') or []}
    if 'reproduces' in card:
        ids = card['reproduces']
    elif card.get('origin') == FROM_LOG and source:
        ids = [rule_id for rule_id in failed_in(source) if rule_id in criteria]
    else:
        ids = []
    found = []
    for rule_id in ids:
        criterion, row = criteria.get(rule_id) or {}, rows.get(rule_id) or {}
        found.append(
            {
                'ruleId': rule_id,
                'name': _named(criterion, row.get('rule') or rule_id),
                'text': criterion.get('text') or row.get('rule', ''),
                'agentQuote': row.get('agentQuote', '') if row.get('status') == 'FAIL' else '',
            }
        )
    return found


def played(runs: list[dict], ids: set[str]) -> dict[str, list[dict]]:
    """Every finished conversation of each scenario in the runs given (newest first): which run, who played it, its
    result, the criteria it failed, and where it is in its run (index). One still playing has no result yet."""
    history: dict[str, list[dict]] = {card_id: [] for card_id in ids}
    for record in runs:
        for index, item in enumerate(record.get('items') or []):
            if item.get('cardId') not in history or item.get('status') not in FINISHED:
                continue
            frozen = item.get('criteria') if isinstance(item.get('criteria'), list) else []
            criteria = {criterion['id']: criterion for criterion in frozen}
            failed = [
                {'ruleId': row['ruleId'], 'name': _named(criteria.get(row['ruleId']) or {}, row.get('rule', ''))}
                for row in item.get('rules') or []
                if row.get('status') == 'FAIL' and row.get('ruleId')
            ]
            history[item['cardId']].append(
                {
                    'run': record['id'],
                    'label': record.get('label') or '',
                    'startedAt': record.get('startedAt'),
                    'persona': item.get('persona') or DEFAULT,
                    'attempt': item.get('attempt', 1),
                    'status': item['status'],
                    'index': index,
                    'failed': failed,
                }
            )
    return history
