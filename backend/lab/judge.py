"""The LLM judge: a verdict per rule with the agent's own words as evidence, then an independent second judge.

Statuses of a rule: PASS, FAIL, UNKNOWN (no evidence either way), NOT_APPLICABLE (the moment did not arise).
A conversation fails if any rule fails, passes only when every applicable rule passes, and is UNMEASURED
otherwise. A PASS or FAIL must be grounded in the evidence named by the rule's observation.
"""

import asyncio
from collections.abc import Awaitable, Callable

from . import llm, quotes
from .context import knowledge
from .prompts import JUDGE_LOG, JUDGE_RUN
from .transcript import for_judge, tool_calls, with_buttons

STATUSES = {'PASS', 'FAIL', 'UNKNOWN', 'NOT_APPLICABLE'}
MARKS = {'PASS': '✓', 'FAIL': '✗', 'UNKNOWN': '?', 'NOT_APPLICABLE': '–', 'UNMEASURED': '?'}
NO_QUOTE = 'Цитата судьи не найдена в ответах агента; вывод не засчитан. '

Verdict = tuple[list[dict], str]  # rows per rule, verdict of the conversation


def verdict_of(rows: list[dict]) -> str:
    statuses = {r['status'] for r in rows}
    if 'FAIL' in statuses:
        return 'FAIL'
    if 'PASS' in statuses and statuses <= {'PASS', 'NOT_APPLICABLE'}:
        return 'PASS'
    return 'UNMEASURED'


def _check_answer(value: dict, rules: list[dict], *, customer_goal: bool = False) -> None:
    """Validate the complete model answer inside the structured-call retry, before interpreting any verdict."""
    rows = value.get('rules')
    if not isinstance(rows, list) or len(rows) != len(rules):
        raise ValueError('expected exactly one verdict per criterion')
    expected = {rule['id'] for rule in rules}
    seen = set()
    for row in rows:
        if not isinstance(row, dict) or not isinstance(row.get('ruleId'), str):
            raise ValueError('invalid criterion verdict')
        rule_id = row['ruleId']
        if rule_id not in expected or rule_id in seen:
            raise ValueError('unknown or duplicated criterion')
        seen.add(rule_id)
        if row.get('status') not in STATUSES:
            raise ValueError('invalid verdict status')
        if not isinstance(row.get('reason'), str) or not row['reason'].strip():
            raise ValueError('verdict needs a reason')
        if not isinstance(row.get('agentQuote'), str) or not isinstance(row.get('title', ''), str):
            raise ValueError('invalid verdict evidence')
        if row['status'] in ('PASS', 'FAIL') and not row['agentQuote'].strip():
            raise ValueError('measured verdict needs a quote')
    if customer_goal and (not isinstance(value.get('customerGoal'), str) or not value['customerGoal'].strip()):
        raise ValueError('run verdict needs a customer goal')


def checked(
    rows: list[dict], rules: list[dict], agent_text: str, *, tools: str = '', knowledge_available: bool = False
) -> list[dict]:
    """One row per criterion; validate reply, tool and knowledge evidence at this single seam.

    The Lab does not record backend state changes, so a state criterion cannot be measured here.
    Applicability is evaluated separately: a criterion that did not arise remains NOT_APPLICABLE.
    """
    by_rule = {r.get('ruleId'): r for r in rows if isinstance(r, dict)}
    out = []
    for rule in rules:
        row = by_rule.get(rule['id']) or {'status': 'UNKNOWN', 'reason': 'Судья не вернул оценку этого правила.'}
        status = row.get('status') if row.get('status') in STATUSES else 'UNKNOWN'
        reason = str(row.get('reason') or '')
        quote = str(row.get('agentQuote') or '')
        if status in ('PASS', 'FAIL'):
            observation = rule.get('observation', 'reply')
            evidence = tools if observation == 'tool' else agent_text
            missing_evidence = {
                'reply': '',
                'tool': '' if tools else 'Вызовы инструментов не записаны. ',
                'state': 'Изменения состояния не записаны. ',
                'knowledge': '' if knowledge_available else 'Нет статей или готовых ответов для проверки знаний. ',
            }
            missing = missing_evidence.get(observation, 'Неизвестный способ проверки критерия. ')
            if missing or not quotes.found(quote, evidence):
                status, reason = 'UNKNOWN', (missing or NO_QUOTE) + reason
        out.append(
            {
                'ruleId': rule['id'],
                'rule': rule['text'],
                'status': status,
                'reason': reason,
                'agentQuote': quote if status in ('PASS', 'FAIL') else '',
                'title': str(row.get('title') or ''),
            }
        )
    return out


async def log_verdict(rules: list[dict], shown: list[dict], endpoint: llm.Endpoint | None = None) -> Verdict:
    """A recorded conversation from the logs; shown = [{'role': 'CUSTOMER' | 'AGENT', 'text'}]."""
    agent_text = '\n'.join(m['text'] for m in shown if m['role'] == 'AGENT')
    value = await llm.structured(
        JUDGE_LOG,
        {'expectations': rules, 'conversation': shown},
        check=lambda value: _check_answer(value, rules),
        endpoint=endpoint,
    )
    rows = checked(value.get('rules') or [], rules, agent_text)
    return rows, verdict_of(rows)


async def run_verdict(card: dict, conversation: list[dict], endpoint: llm.Endpoint | None = None) -> Verdict:
    """A conversation the synthetic customer just had with the agent, against the card's criteria."""
    shown = [{'role': m['role'].upper(), 'text': for_judge(m)} for m in conversation]
    agents = [message for message in conversation if message['role'] == 'agent']
    agent_text = '\n'.join(with_buttons(message) for message in agents)
    calls = '\n'.join(call for message in agents for call in tool_calls(message))
    retrieved = await asyncio.to_thread(knowledge.retrieved, conversation)
    payload = {
        'expectations': card['criteria'],
        'conversation': shown,
        'toolCallsObserved': bool(calls),
        'knowledge': retrieved,
    }
    value = await llm.structured(
        JUDGE_RUN,
        payload,
        check=lambda answer: _check_answer(answer, card['criteria'], customer_goal=True),
        endpoint=endpoint,
    )
    rows = checked(value['rules'], card['criteria'], agent_text, tools=calls, knowledge_available=bool(retrieved))
    return rows, verdict_of(rows)


async def second_opinion(verdict: Callable[..., Awaitable[Verdict]], *args) -> dict:
    """The same verdict by the second judge: another vendor's model, the same rules and evidence checks."""
    try:
        rows, status = await verdict(*args, endpoint=llm.SECOND)
    except llm.ModelError as error:
        return {'model': llm.SECOND[1], 'status': 'ERROR', 'error': str(error)}
    return {'model': llm.SECOND[1], 'status': status, 'rules': rows}


async def evaluate(card: dict, item: dict) -> None:
    """Judge a run's conversation in place: rows, verdict and the second judge's verdict."""
    try:
        async with asyncio.TaskGroup() as tasks:
            primary = tasks.create_task(run_verdict(card, item['conversation']))
            secondary = tasks.create_task(second_opinion(run_verdict, card, item['conversation']))
    except* llm.ModelError as errors:
        raise llm.ModelError(str(errors.exceptions[0])) from errors
    item['rules'], item['status'] = primary.result()
    item['second'] = secondary.result()


def note(
    status: str,
    context: str,
    rows: list[dict],
    error: str | None = None,
    second: dict | None = None,
    recorded: bool = False,
) -> str:
    """The judge's explanation for a person: the reason first, then every criterion with the agent's quote."""
    if status == 'FAIL':
        fail = next(r for r in rows if r['status'] == 'FAIL')
        head = ('Нарушение: ' if recorded else 'Не пройден: ') + fail['reason']
    elif status == 'PASS':
        passed = next(r for r in rows if r['status'] == 'PASS')
        head = ('Без нарушений: ' if recorded else 'Пройден: ') + passed['reason']
    else:
        head = 'Не измерено: ' + (error or 'не все применимые критерии подтверждены доказательствами.')
    lines = [head, '', context]
    if second and second.get('status') in ('PASS', 'FAIL', 'UNMEASURED'):
        words = {'PASS': 'пройден', 'FAIL': 'не пройден', 'UNMEASURED': 'не измерено'}
        agree = 'согласен' if second['status'] == status else f'не согласен: по его оценке {words[second["status"]]}'
        lines.append(f'Второй судья: {agree}.')
    for row in rows:
        lines += ['', f'{MARKS[row["status"]]} {row["rule"]}', f'   {row["reason"]}']
        if row['agentQuote']:
            lines.append(f'   Цитата агента: «{row["agentQuote"]}»')
    return '\n'.join(lines)
