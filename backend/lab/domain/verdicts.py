"""What a verdict stands on: one row per criterion of a conversation, PASS or FAIL only on the evidence its criterion
observes, and the conversation's status from its rows.

Statuses of a criterion: PASS, FAIL, UNKNOWN (no evidence either way), NOT_APPLICABLE (the moment did not arise).
A conversation fails if any criterion fails, passes only when every applicable one passes, and is UNMEASURED
otherwise. A reply's words are evidence of what the agent said, never of a call to a bank's system: those are only the
calls the stand recorded.
"""

from collections.abc import Sequence
from typing import Protocol

from . import match, quotes
from .export import words

NO_QUOTE = 'Модель привела цитату, которой нет в ответах агента. Вывод не засчитан. '
NO_RAG_QUOTE = 'Модель привела цитату, которой нет в обращении к базе знаний. Вывод не засчитан. '


class Row(Protocol):
    """A judge's row on one criterion, as its answer gives it (roles.judge.RuleReply)."""

    rule_id: str
    status: str
    reason: str
    agent_quote: str
    title: str


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


def checked(
    rows: Sequence[Row],
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
    buttons as «[Кнопки: …]», but that line is the Lab's rendering of export codes (the judge's instructions say as
    much)."""
    return '\n'.join(words(m['text']) for m in shown if m['role'] == 'AGENT')
