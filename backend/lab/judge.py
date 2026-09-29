"""The LLM judge: a verdict per rule with the agent's own words as evidence, then an independent second judge.

Statuses of a rule: PASS, FAIL, UNKNOWN (no evidence either way), NOT_APPLICABLE (the moment did not arise).
A conversation fails if any rule fails, passes only when every applicable rule passes, and is UNMEASURED
otherwise. A PASS or FAIL must be grounded in the evidence named by the rule's observation.
"""

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

from . import llm, quotes
from .context import knowledge
from .judge_reply import JudgeReply, RuleReply
from .prompts import JUDGE_LOG, JUDGE_RUN
from .transcript import for_judge, tool_calls, with_buttons

NO_QUOTE = 'Цитата судьи не найдена в ответах агента; вывод не засчитан. '


@dataclass(frozen=True)
class Verdict:
    rows: list[dict]
    status: str
    model: str


def verdict_of(rows: list[dict]) -> str:
    statuses = {r['status'] for r in rows}
    if 'FAIL' in statuses:
        return 'FAIL'
    if 'PASS' in statuses and statuses <= {'PASS', 'NOT_APPLICABLE'}:
        return 'PASS'
    return 'UNMEASURED'


def _parse_reply(value: dict, rules: list[dict], *, customer_goal: bool = False) -> JudgeReply:
    """Shape belongs to JudgeReply; criterion coverage and applicability belong to this module."""
    reply = JudgeReply.model_validate(value)
    expected = {rule['id'] for rule in rules}
    received = [row.rule_id for row in reply.rules]
    if len(received) != len(rules) or len(set(received)) != len(received) or set(received) != expected:
        raise ValueError('expected exactly one verdict per criterion')
    if customer_goal and reply.customer_goal is None:
        raise ValueError('run verdict needs a customer goal')
    return reply


def checked(
    rows: list[RuleReply], rules: list[dict], agent_text: str, *, tools: str = '', knowledge_available: bool = False
) -> list[dict]:
    """One row per criterion; validate reply, tool and knowledge evidence at this single seam.

    The Lab does not record backend state changes, so a state criterion cannot be measured here.
    Applicability is evaluated separately: a criterion that did not arise remains NOT_APPLICABLE.
    """
    by_rule = {row.rule_id: row for row in rows}
    out = []
    for rule in rules:
        row = by_rule[rule['id']]
        status, reason, quote = row.status, row.reason, row.agent_quote
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
                'title': row.title,
            }
        )
    return out


async def log_verdict(rules: list[dict], shown: list[dict], endpoint: llm.Endpoint | None = None) -> Verdict:
    """A recorded conversation from the logs; shown = [{'role': 'CUSTOMER' | 'AGENT', 'text'}]."""
    agent_text = '\n'.join(m['text'] for m in shown if m['role'] == 'AGENT')
    answer = await llm.structured(
        JUDGE_LOG,
        {'expectations': rules, 'conversation': shown},
        parse=lambda value: _parse_reply(value, rules),
        endpoint=endpoint,
    )
    rows = checked(answer.value.rules, rules, agent_text)
    return Verdict(rows, verdict_of(rows), answer.model)


@dataclass(frozen=True)
class _RunEvidence:
    criteria: list[dict]
    payload: dict
    agent_text: str
    tools: str
    knowledge_available: bool


async def _prepare_run(card: dict, conversation: list[dict]) -> _RunEvidence:
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
    return _RunEvidence(card['criteria'], payload, agent_text, calls, bool(retrieved))


async def _run_prepared(evidence: _RunEvidence, endpoint: llm.Endpoint | None = None) -> Verdict:
    answer = await llm.structured(
        JUDGE_RUN,
        evidence.payload,
        parse=lambda answer: _parse_reply(answer, evidence.criteria, customer_goal=True),
        endpoint=endpoint,
    )
    rows = checked(
        answer.value.rules,
        evidence.criteria,
        evidence.agent_text,
        tools=evidence.tools,
        knowledge_available=evidence.knowledge_available,
    )
    return Verdict(rows, verdict_of(rows), answer.model)


async def run_verdict(card: dict, conversation: list[dict], endpoint: llm.Endpoint | None = None) -> Verdict:
    """A conversation the synthetic customer just had with the agent, against the card's criteria."""
    return await _run_prepared(await _prepare_run(card, conversation), endpoint)


async def second_opinion(verdict: Callable[..., Awaitable[Verdict]], *args) -> dict:
    """Another configured judge call, with the same rules and evidence checks; model identity comes from its call."""
    try:
        result = await verdict(*args, endpoint=llm.SECOND)
    except llm.ModelError as error:
        return {'model': llm.SECOND[1], 'status': 'ERROR', 'error': str(error)}
    return {'model': result.model, 'status': result.status, 'rules': result.rows}


async def evaluate(card: dict, item: dict) -> None:
    """Judge a run's conversation in place: rows, verdict and the second judge's verdict."""
    evidence = await _prepare_run(card, item['conversation'])
    try:
        async with asyncio.TaskGroup() as tasks:
            primary = tasks.create_task(_run_prepared(evidence))
            secondary = tasks.create_task(second_opinion(_run_prepared, evidence))
    except* llm.ModelError as errors:
        raise llm.ModelError(str(errors.exceptions[0])) from errors
    result = primary.result()
    item.update(rules=result.rows, status=result.status, model=result.model)
    item['second'] = secondary.result()
