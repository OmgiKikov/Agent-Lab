"""The LLM judge: a verdict per rule with the agent's own words as evidence, then an independent second judge.

Statuses of a rule: PASS, FAIL, UNKNOWN (no evidence either way), NOT_APPLICABLE (the moment did not arise).
A conversation fails if any rule fails, passes if at least one rule passes and none fails, and is UNMEASURED
otherwise. A PASS or FAIL whose quote is not found in the agent's replies does not count.
"""

import asyncio
from collections.abc import Awaitable, Callable

from . import llm, quotes
from .context import knowledge
from .prompts import JUDGE_LOG, JUDGE_RUN
from .transcript import for_judge, with_tools

STATUSES = {'PASS', 'FAIL', 'UNKNOWN', 'NOT_APPLICABLE'}
MARKS = {'PASS': '✓', 'FAIL': '✗', 'UNKNOWN': '?', 'NOT_APPLICABLE': '–', 'UNMEASURED': '?'}
NO_QUOTE = 'Цитата судьи не найдена в ответах агента; вывод не засчитан. '

Verdict = tuple[list[dict], str]  # rows per rule, verdict of the conversation


def verdict_of(rows: list[dict]) -> str:
    statuses = {r['status'] for r in rows}
    if 'FAIL' in statuses:
        return 'FAIL'
    if 'PASS' in statuses:
        return 'PASS'
    return 'UNMEASURED'


def checked(rows: list[dict], rules: list[dict], agent_text: str) -> list[dict]:
    """One row per rule, in the rules' order; a PASS or FAIL without a verbatim agent quote becomes UNKNOWN."""
    by_rule = {r.get('ruleId'): r for r in rows if isinstance(r, dict)}
    out = []
    for rule in rules:
        row = by_rule.get(rule['id']) or {'status': 'UNKNOWN', 'reason': 'Судья не вернул оценку этого правила.'}
        status = row.get('status') if row.get('status') in STATUSES else 'UNKNOWN'
        reason = str(row.get('reason') or '')
        quote = str(row.get('agentQuote') or '')
        if status in ('PASS', 'FAIL') and not quotes.found(quote, agent_text):
            status, reason = 'UNKNOWN', NO_QUOTE + reason
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


def own_words(rows: list[dict], conversation: list[dict]) -> list[dict]:
    """Evidence must be the agent's own words. A quote taken from the handoff marker is replaced by the agent's
    service reply itself (the handoff is the evidence); anything else unverifiable becomes UNKNOWN."""
    agents = [m for m in conversation if m['role'] == 'agent']
    raw = '\n'.join(with_tools(m) for m in agents)
    handoff = next((m for m in agents if not m.get('ok', True)), None)
    for row in rows:
        if row['status'] not in ('PASS', 'FAIL') or quotes.found(row['agentQuote'], raw):
            continue
        if handoff:
            row['agentQuote'] = f'служебный ответ {handoff["status"]}: {handoff["text"]}'
        else:
            row.update(status='UNKNOWN', agentQuote='', reason=NO_QUOTE + row['reason'])
    return rows


async def log_verdict(rules: list[dict], shown: list[dict], endpoint: llm.Endpoint | None = None) -> Verdict:
    """A recorded conversation from the logs; shown = [{'role': 'CUSTOMER' | 'AGENT', 'text'}]."""
    agent_text = '\n'.join(m['text'] for m in shown if m['role'] == 'AGENT')
    value = await llm.structured(
        JUDGE_LOG, {'expectations': rules, 'conversation': shown}, check=lambda v: v['rules'], endpoint=endpoint
    )
    rows = checked(value.get('rules') or [], rules, agent_text)
    return rows, verdict_of(rows)


async def run_verdict(card: dict, conversation: list[dict], endpoint: llm.Endpoint | None = None) -> Verdict:
    """A conversation the synthetic customer just had with the agent, against the card's criteria."""
    shown = [{'role': m['role'].upper(), 'text': for_judge(m)} for m in conversation]
    agent_text = '\n'.join(m['text'] for m in shown if m['role'] == 'AGENT')
    payload = {
        'expectations': card['criteria'],
        'conversation': shown,
        'toolCallsObserved': any(m.get('events') for m in conversation if m['role'] == 'agent'),
        'knowledge': await asyncio.to_thread(knowledge.retrieved, conversation),
    }
    value = await llm.structured(JUDGE_RUN, payload, check=lambda v: v['rules'], endpoint=endpoint)
    rows = checked(value.get('rules') or [], card['criteria'], agent_text)
    rows = knowledge.guard(own_words(rows, conversation))
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
    item['rules'], item['status'] = await run_verdict(card, item['conversation'])
    item['second'] = await second_opinion(run_verdict, card, item['conversation'])


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
        head = 'Не измерено: ' + (
            error or 'у судьи нет доказательств ни по одному критерию — ни выполнения, ни нарушения.'
        )
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
