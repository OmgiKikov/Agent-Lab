"""The synthetic customer: writes to the agent in the situation of a scenario, in the manner of a type of customer
(domain: personas), and ends the conversation with END. Answers in words."""

from .base import Answer, Role, ask, instructions

END = '[КОНЕЦ]'
CUSTOMER = Role('customer', instructions('customer'), str)
OPENING = Role('customer.opening', instructions('customer.opening'), str)


def _said(text: str) -> str:
    """The customer's line without the quotes a model may put around it."""
    return text.strip().strip('"«»').strip()


async def reply(situation: str, transcript: str, details: str = '', manner: str = '') -> Answer[str]:
    """The customer's next line, or END, after the conversation so far (transcript: «КЛИЕНТ (это ты): …», «АГЕНТ: …»).
    details: what the customer gives when the agent asks for its organization, terminal or INN; manner: how it
    writes."""
    profile = (
        f'Реквизиты (называй их, если агент спросит номер терминала, организацию или ИНН): {details}' if details else ''
    )
    persona = f'Твоя манера общения (она важнее правил о длине и стиле ниже): {manner}' if manner else ''
    request = (
        f'Переписка в чате:\n\n{transcript}\n\n'
        'Напиши следующую реплику клиента в ответ на последнее сообщение агента или [КОНЕЦ].'
    )
    fields = {'situation': situation, 'profile': profile, 'persona': persona}
    return await ask(CUSTOMER, request, fields=fields, accept=_said)


async def opening(text: str, manner: str) -> Answer[str]:
    """The first message of a scenario rewritten in a customer's manner: the same request and facts."""
    return await ask(OPENING, text, fields={'style': manner}, accept=_said)
