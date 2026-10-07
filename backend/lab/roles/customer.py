"""The synthetic customer: writes to the agent in the situation of a scenario, in the manner of a type of customer
(domain: personas), and ends the conversation with a mark that says why (ending). Answers in words."""

import re

from .base import Answer, Role, ask, instructions

# «[КОНЕЦ: решено]»: the customer's own reason to end; a bare or unknown one ends it without a reason.
END = re.compile(r'\[\s*КОНЕЦ\s*(?::\s*([^\]]*))?\]', re.I)
REASONS = {'решено': 'resolved', 'инструкция': 'instruction', 'ухожу': 'gave_up'}
CUSTOMER = Role('customer', instructions('customer'), str)
OPENING = Role('customer.opening', instructions('customer.opening'), str)


def _said(text: str) -> str:
    """The customer's line without the quotes a model may put around it."""
    return text.strip().strip('"«»').strip()


def ending(line: str) -> tuple[str, str | None]:
    """The customer's line without the end mark, and why the customer ended the conversation (REASONS; «ended» for a
    mark without a known reason), or None while it goes on."""
    found = END.search(line)
    if not found:
        return line.strip(), None
    return _said(END.sub('', line)), REASONS.get((found.group(1) or '').strip().lower(), 'ended')


async def reply(situation: str, transcript: str, details: str = '', manner: str = '') -> Answer[str]:
    """The customer's next line, with an end mark when the customer ends the conversation (ending), after the
    conversation so far (transcript: «КЛИЕНТ (это ты): …», «АГЕНТ: …»).
    details: what the customer gives when the agent asks for its organization, terminal or INN; manner: how it
    writes."""
    profile = (
        f'Реквизиты (называй их, если агент спросит номер терминала, организацию или ИНН): {details}' if details else ''
    )
    persona = f'Твоя манера общения (она важнее манеры, описанной в ситуации): {manner}' if manner else ''
    request = (
        f'Переписка в чате:\n\n{transcript}\n\n'
        'Напиши следующую реплику клиента в ответ на последнее сообщение агента; если разговор для тебя закончен, '
        'с меткой [КОНЕЦ: …].'
    )
    fields = {'situation': situation, 'profile': profile, 'persona': persona}
    return await ask(CUSTOMER, request, fields=fields, accept=_said)


async def opening(text: str, manner: str) -> Answer[str]:
    """The first message of a scenario rewritten in a customer's manner: the same request and facts."""
    return await ask(OPENING, text, fields={'style': manner}, accept=_said)
