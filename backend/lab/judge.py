"""The LLM judge: a verdict per rule with the agent's own words as evidence, then an independent second judge.

Statuses of a rule: PASS, FAIL, UNKNOWN (no evidence either way), NOT_APPLICABLE (the moment did not arise).
A conversation fails if any rule fails, passes only when every applicable rule passes, and is UNMEASURED
otherwise. A PASS or FAIL must be grounded in the evidence named by the rule's observation.
"""

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

from . import llm, logs, match, quotes, rag
from .context import knowledge
from .judge_reply import JudgeReply, RuleReply
from .prompts import JUDGE_LOG, JUDGE_REPLAY, JUDGE_RUN
from .transcript import for_judge, tool_calls

NO_QUOTE = 'Модель привела цитату, которой нет в ответах агента. Вывод не засчитан. '
NO_RAG_QUOTE = 'Модель привела цитату, которой нет в обращении к базе знаний. Вывод не засчитан. '


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


def step_status(rows: list[dict]) -> str:
    """A replayed step's status: its rows but the match with production (match.py)."""
    return verdict_of(match.counted(rows))


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
    rows: list[RuleReply],
    rules: list[dict],
    agent_text: str,
    *,
    tools: str = '',
    knowledge_available: bool = False,
    rag_text: str = '',
) -> list[dict]:
    """One row per criterion; validate reply, tool, knowledge and knowledge-base call (rag_text) evidence at this
    single seam.

    The Lab does not record backend state changes, so a state criterion cannot be measured here.
    Applicability is evaluated separately: a criterion that did not arise remains NOT_APPLICABLE.
    """
    by_rule = {row.rule_id: row for row in rows}
    out = []
    for rule in rules:
        row = by_rule.get(rule['id'])
        if row is None:
            # The model gave no verdict here (it did not answer at all): the criterion stays unmeasured.
            out.append(
                {
                    'ruleId': rule['id'],
                    'rule': rule['text'],
                    'status': 'UNKNOWN',
                    'reason': '',
                    'agentQuote': '',
                    'title': '',
                }
            )
            continue
        status, reason, quote = row.status, row.reason, row.agent_quote
        if status in ('PASS', 'FAIL'):
            observation = rule.get('observation', 'reply')
            evidence = {'tool': tools, 'rag': rag_text}.get(observation, agent_text)
            missing_evidence = {
                'reply': '',
                'tool': '' if tools else 'Вызовы инструментов не записаны. ',
                'rag': '' if rag_text else 'Обращение к базе знаний не записано. ',
                'state': 'Изменения в системах банка не записаны. ',
                'knowledge': ''
                if knowledge_available
                else 'Нет статей и готовых ответов, чтобы сверить с ними ответ агента. ',
            }
            missing = missing_evidence.get(observation, 'Неизвестный способ проверки критерия. ')
            if missing or not quotes.cited(quote, evidence):
                status, reason = 'UNKNOWN', (missing or (NO_RAG_QUOTE if observation == 'rag' else NO_QUOTE)) + reason
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


def log_words(shown: list[dict]) -> str:
    """What the agent wrote in a recorded conversation, the only text its verdicts may quote. The judge also sees the
    buttons as «[Кнопки: …]», but that line is the Lab's rendering of export codes (JUDGE_LOG says as much)."""
    return '\n'.join(logs.words(m['text']) for m in shown if m['role'] == 'AGENT')


async def log_verdict(rules: list[dict], shown: list[dict], endpoint: llm.Endpoint | None = None) -> Verdict:
    """A recorded conversation from the logs; shown = [{'role': 'CUSTOMER' | 'AGENT', 'text'}]."""
    answer = await llm.structured(
        JUDGE_LOG,
        {'expectations': rules, 'conversation': shown},
        parse=lambda value: _parse_reply(value, rules),
        endpoint=endpoint,
    )
    rows = checked(answer.value.rules, rules, log_words(shown))
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
    # The agent's words and its buttons' labels: the agent wrote both, the Lab's «[Кнопки: …]» around them it did not.
    agent_text = '\n'.join(line for message in agents for line in (message['text'], *(message.get('options') or [])))
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


async def step_verdict(rules: list[dict], step: dict, endpoint: llm.Endpoint | None = None) -> Verdict:
    """One step of a replayed conversation (replay.py): the agent's new reply and its trace against the rules, with
    production's reply for the match with it (match.py)."""
    reply, trace = step['reply'], step.get('trace')
    shown_history = [
        {'role': 'CUSTOMER', 'text': m['text']}
        if m['role'] == 'customer'
        else {'role': 'AGENT', 'text': logs.as_seen(m['text'])}
        for m in step['history']
    ]
    payload = {
        'expectations': rules,
        'history': shown_history,
        'customerMessage': step['customer'],
        'replayReply': {'text': reply['text'], 'status': reply['status'], 'buttons': reply.get('options') or []},
        'prodReply': step.get('prodReply'),
        'trace': rag.for_judge(trace),
    }
    answer = await llm.structured(
        JUDGE_REPLAY, payload, parse=lambda value: _parse_reply(value, rules), endpoint=endpoint
    )
    agent_text = '\n'.join([reply['text'], *(reply.get('options') or [])])
    rows = checked(
        answer.value.rules,
        rules,
        agent_text,
        tools=rag.tools(trace),
        knowledge_available=rag.called(trace),
        rag_text=rag.evidence(trace),
    )
    return Verdict(rows, step_status(rows), answer.model)


async def second_opinion(verdict: Callable[..., Awaitable[Verdict]], *args) -> dict | None:
    """Another model's verdict on the same rules and evidence; model identity comes from its call. None when only one
    model is available: asking it twice is not a second opinion."""
    endpoint = llm.second_judge()
    if endpoint is None:
        return None
    try:
        result = await verdict(*args, endpoint=endpoint)
    except llm.ModelError as error:
        return {'model': endpoint[1], 'status': 'ERROR', 'error': str(error)}
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
