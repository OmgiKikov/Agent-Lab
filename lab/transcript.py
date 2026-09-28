"""How a conversation with the agent is shown to the synthetic customer, the judge and Workshop.

A message is {'role': 'customer' | 'agent', 'text', ...}; an agent message also carries its status, 'ok' (the agent
answered itself; otherwise it handed the conversation to an operator), buttons ('options') and system calls ('events').
"""


def with_buttons(message: dict) -> str:
    options = message.get('options') or []
    return message['text'] + ('\n[Кнопки: ' + ' | '.join(options) + ']' if options else '')


def with_tools(message: dict) -> str:
    """The reply with its buttons and the systems it called in this turn (known where the mocks record them)."""
    calls = [
        event['tool'].replace('Система банка · ', '') + (f' ({event["article"]})' if event.get('article') else '')
        for event in message.get('events') or []
    ]
    return with_buttons(message) + ('\n[вызовы систем: ' + '; '.join(calls) + ']' if calls else '')


def for_judge(message: dict) -> str:
    if message.get('ok', True):
        return with_tools(message)
    return f'[служебный статус {message["status"]}: бот не ответил сам, разговор передан оператору] {message["text"]}'


def for_trace(message: dict) -> str:
    if message.get('ok', True):
        return with_buttons(message)
    return f'[служебный статус {message.get("status")}: передача оператору] {message["text"]}'
