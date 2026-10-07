"""A model behind an OpenAI-compatible endpoint: OpenRouter, or the address in LAB_MODEL_URL or LAB_SECOND_URL."""

import httpx

from .completion import Completion, usage
from .errors import MalformedAnswer, ModelError, refused

OPENROUTER = 'https://openrouter.ai/api/v1'  # without the gateway and LAB_MODEL_URL; its key is OPENROUTER_API_KEY
# OpenRouter without its key: no conversation is sent, and the settings and every check say what to set.
NO_KEY = 'Нет ключа OpenRouter. Задайте OPENROUTER_API_KEY и перезапустите Agent Lab.'


async def chat(
    base: str,
    model: str,
    key: str | None,
    system: str,
    messages: list[dict],
    json_mode: bool,
    timeout: httpx.Timeout,
) -> Completion:
    body = {'model': model, 'stream': False, 'messages': [{'role': 'system', 'content': system}, *messages]}
    if json_mode:
        body['response_format'] = {'type': 'json_object'}
    if base == OPENROUTER:
        if not key:
            raise ModelError(NO_KEY)
        # A short reasoning, so a reasoning model answers within its output limit; the others ignore it. The answer
        # names its tokens and cost (the journal of calls).
        body['reasoning'] = {'effort': 'low'}
        body['usage'] = {'include': True}
    async with httpx.AsyncClient(timeout=timeout) as client:
        response = await client.post(
            f'{base}/chat/completions', json=body, headers={'Authorization': f'Bearer {key}'} if key else {}
        )
    if response.status_code != 200:
        raise refused('Модель ответила ошибкой', response)
    try:
        data = response.json()
    except ValueError as error:
        raise MalformedAnswer('Модель ответила не в JSON.') from error
    if not isinstance(data, dict) or not isinstance(data.get('choices'), list) or not data['choices']:
        raise MalformedAnswer('В ответе модели нет choices.')
    choice = data['choices'][0]
    if not isinstance(choice, dict) or not isinstance(choice.get('message'), dict):
        raise MalformedAnswer('В ответе модели нет message.')
    text = choice['message'].get('content')
    if not isinstance(text, str):
        raise MalformedAnswer('Текст ответа модели не строка.')
    label = data.get('model', model)
    if not isinstance(label, str) or not label.strip():
        raise MalformedAnswer('Имя модели в ответе не строка.')
    return Completion(text, label, **usage(data))
