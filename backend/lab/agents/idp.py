"""IDP retrieval using the agent's existing /predict contract. Only returned passages become evidence."""

import ssl
import uuid

import httpx

from .. import config


def request(query: str, index: str, embedder: str, filter_value: str) -> dict:
    message = {'messages': [{'role': 'user', 'content': query}]}
    if filter_value:
        message['filter'] = {
            'field': 'breadcrumbs',
            'value': filter_value,
            'operator': 'wildcard',
            'operator_configuration': {'case_insensitive': False},
        }
    return {
        'meta': {'external_uuid': str(uuid.uuid4())},
        'message': {'request_type': 'chat', 'request': message},
        'path': '/predict',
        'timeout': 30,
        'configuration': {
            'agent_type': 'universal',
            'agent_configuration': {
                'index_type': 'opensearch',
                'data_sources': [{'index_id': index}],
                'retriever': {'size': 5, 'embedder': {'model_name': embedder}},
                'qa': {'enabled': False},
                'sources': {'enabled': True, 'source_type': 'passage'},
            },
        },
    }


def passages(value: dict) -> list[dict]:
    if not isinstance(value, dict):
        raise ValueError('IDP вернула ответ неизвестного формата.')
    if value.get('status') == 'ERROR':
        raise ValueError('IDP вернула ошибку поиска. Проверьте индекс и доступ к базе знаний.')
    result = value.get('result') or {}
    response = result.get('response', {}) if isinstance(result, dict) else {}
    messages = response.get('messages', []) if isinstance(response, dict) else []
    if not isinstance(messages, list):
        raise ValueError('В ответе IDP нет списка источников.')
    found = []
    for message in messages:
        sources = message.get('sources') if isinstance(message, dict) else None
        for source in sources if isinstance(sources, list) else []:
            content = source.get('content') if isinstance(source, dict) else None
            if isinstance(content, str) and content.strip():
                metadata = source.get('metadata') or {}
                metadata = metadata if isinstance(metadata, dict) else {}
                found.append(
                    {
                        'article': str(metadata.get('index', len(found) + 1)),
                        'title': str(metadata.get('title') or 'Источник IDP'),
                        'text': content[:16000],
                    }
                )
    return found[:5]


async def retrieve(context: dict, query: str) -> list[dict]:
    settings = config.current()
    headers = {'Authorization': f'Bearer {settings.idp_key.get_secret_value()}'} if settings.idp_key else {}
    payload = request(query, context['idpIndex'], context['idpEmbedder'], context['idpFilter'])
    if settings.idp_source_id:
        payload['meta']['source_uuid'] = settings.idp_source_id
    if settings.idp_sender or settings.idp_receiver:
        payload['msgProperties'] = {
            key: value for key, value in (('sender', settings.idp_sender), ('receiver', settings.idp_receiver)) if value
        }
    try:
        tls = ssl.create_default_context(cafile=str(settings.idp_ca) if settings.idp_ca else None)
        if settings.idp_cert:
            tls.load_cert_chain(
                str(settings.idp_cert), str(settings.idp_client_key) if settings.idp_client_key else None
            )
    except (OSError, ssl.SSLError) as error:
        raise ValueError(
            'Не удалось прочитать сертификаты IDP. Проверьте настройки LAB_IDP_CA/CERT/CLIENT_KEY.'
        ) from error
    async with httpx.AsyncClient(timeout=35, follow_redirects=False, verify=tls) as client:
        try:
            response = await client.post(
                context['idpUrl'],
                headers=headers,
                json=payload,
            )
            response.raise_for_status()
        except httpx.HTTPError as error:
            code = f'HTTP {error.response.status_code}' if isinstance(error, httpx.HTTPStatusError) else 'нет ответа'
            raise ValueError(
                f'Не удалось получить источники IDP ({code}). Проверьте адрес, индекс и доступ.'
            ) from error

        try:
            value = response.json()
        except ValueError as error:
            raise ValueError('IDP вернула ответ не в формате JSON. Проверьте адрес API.') from error
        return passages(value)
