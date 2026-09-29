"""The bank's model gateway over mutual TLS (the work computer).

Where the certificates are: the files dropped into certs/ (url.txt, the certificate and key or one .p12,
password.txt, the bank's root certificate named ca* or root*). ~/.agent-lab/gateway.json (the archived Agent Lab's
format) and AGENT_LAB_GATEWAY_URL / _CERT_PATH / _KEY_PATH / _CA_PATH / _INSECURE take precedence when complete.
Protocol v2: POST /v2/chat/completions and GET /v1/models; the client certificate authenticates, no token.
"""

import json
import os
import re
import ssl
import subprocess
from pathlib import Path

import httpx

from .. import store
from ..settings import CERTS
from .errors import ModelError

FILE = Path(os.environ.get('AGENT_LAB_GATEWAY_FILE', '~/.agent-lab/gateway.json')).expanduser()
FORMAT = 'agent-lab-gateway-1'
MODELS = 'models.json'  # models chosen from the gateway's catalog, in data/
_ENV = {
    'url': 'AGENT_LAB_GATEWAY_URL',
    'cert': 'AGENT_LAB_GATEWAY_CERT_PATH',
    'key': 'AGENT_LAB_GATEWAY_KEY_PATH',
    'ca': 'AGENT_LAB_GATEWAY_CA_PATH',
}


def config() -> dict | None:
    """url, cert, key, ca and insecure; None when the gateway is not set up."""
    settings = _from_file()
    for field, name in _ENV.items():
        if os.environ.get(name):
            settings[field] = os.environ[name]
    if os.environ.get('AGENT_LAB_GATEWAY_INSECURE'):
        settings['insecure'] = os.environ['AGENT_LAB_GATEWAY_INSECURE'] == '1'
    if not _complete(settings):
        settings = _from_certs_folder() or settings
    if not _complete(settings):
        return None
    settings['url'] = re.sub(r'/v[12]$', '', settings['url'].rstrip('/'))
    return settings


def configured() -> bool:
    try:
        return config() is not None
    except ModelError:
        return True  # a broken settings file is reported on the first call, not hidden behind another backend


def _complete(settings: dict) -> bool:
    return bool(settings.get('url') and settings.get('cert') and settings.get('key'))


def _from_file() -> dict:
    if not FILE.exists():
        return {}
    try:
        data = json.loads(FILE.read_text(encoding='utf-8'))
    except (OSError, ValueError) as error:
        raise ModelError(f'Файл настройки шлюза {FILE} повреждён') from error
    if data.get('format') != FORMAT:
        raise ModelError(f'Файл настройки шлюза {FILE}: неизвестный формат')
    return {
        'url': data.get('url'),
        'cert': data.get('certPath'),
        'key': data.get('keyPath'),
        'ca': data.get('caPath'),
        'insecure': bool(data.get('insecure')),
    }


def _from_certs_folder() -> dict | None:
    """certs/: url.txt, a client certificate and key (PEM, or one .p12/.pfx with password.txt),
    and the bank's root certificate named ca* or root* when the gateway needs it."""
    if not (CERTS / 'url.txt').exists():
        return None
    files = [f for f in CERTS.iterdir() if f.is_file()]
    pem = {f: f.read_text(errors='ignore') for f in files if f.suffix.lower() in ('.pem', '.crt', '.cer', '.key')}

    def is_root(path: Path) -> bool:
        return path.stem.lower().startswith(('ca', 'root'))

    cert = next((f for f, text in pem.items() if 'BEGIN CERTIFICATE' in text and not is_root(f)), None)
    key = next((f for f, text in pem.items() if 'PRIVATE KEY' in text), None)
    ca = next((f for f, text in pem.items() if 'BEGIN CERTIFICATE' in text and is_root(f)), None)
    bundle = next((f for f in files if f.suffix.lower() in ('.p12', '.pfx')), None)
    if (not cert or not key) and bundle:
        cert, key = _unpack(bundle)
    if not cert or not key:
        return None
    url = (CERTS / 'url.txt').read_text().strip().splitlines()[0].strip()
    return {'url': url, 'cert': str(cert), 'key': str(key), 'ca': str(ca) if ca else None, 'insecure': False}


def _password() -> str | None:
    path = CERTS / 'password.txt'
    if not path.exists():
        return None
    return path.read_text().strip() or None


def _unpack(bundle: Path) -> tuple[Path, Path]:
    """Split a .p12/.pfx bundle into PEM files with openssl (certs/.converted, owner-only)."""
    out = CERTS / '.converted'
    out.mkdir(mode=0o700, exist_ok=True)
    password = _password() or ''
    for args, name in ((['-clcerts', '-nokeys'], 'client.pem'), (['-nocerts', '-nodes'], 'client.key')):
        command = [
            'openssl',
            'pkcs12',
            '-in',
            str(bundle),
            *args,
            '-out',
            str(out / name),
            '-passin',
            f'pass:{password}',
        ]
        subprocess.run(command, check=True, capture_output=True)
    (out / 'client.key').chmod(0o600)
    return out / 'client.pem', out / 'client.key'


def _client(timeout: float) -> tuple[httpx.AsyncClient, str]:
    settings = config()
    if not settings:
        raise ModelError('Шлюз моделей не настроен: положите url.txt, сертификат и ключ в папку certs/')
    try:
        context = ssl.create_default_context(cafile=settings.get('ca') or None)
        context.load_cert_chain(settings['cert'], settings['key'], password=_password())
    except (OSError, ssl.SSLError) as error:
        raise ModelError(f'Сертификат, ключ или CA шлюза не читаются: {type(error).__name__}') from error
    if settings.get('insecure'):
        context.check_hostname = False
        context.verify_mode = ssl.CERT_NONE
    return httpx.AsyncClient(verify=context, timeout=timeout), settings['url']


async def catalog() -> list[str]:
    """Chat models the gateway offers."""
    client, base = _client(30)
    async with client:
        response = await client.get(base + '/v1/models')
    if response.status_code != 200:
        raise ModelError(f'Шлюз не отдал каталог моделей: HTTP {response.status_code}')
    models = response.json().get('data') or []
    return [m['id'] for m in models if isinstance(m.get('id'), str) and m.get('type', 'chat') == 'chat']


def chosen_models() -> dict:
    return store.load(MODELS, {}) or {}


async def auto_models() -> dict:
    """Unless chosen: the newest full GLM in the catalog, for the judge, the simulator and the second judge."""
    models = chosen_models()
    if models.get('model'):
        return models
    names = await catalog()
    glm = [m for m in names if 'glm' in m.lower()]
    full = [m for m in glm if not any(light in m.lower() for light in ('flash', 'air', 'mini'))]
    ranked = sorted(full or glm, reverse=True)  # a full model (glm-5.2) over a light one (glm-5.3-flash)
    main = ranked[0] if ranked else (names[0] if names else None)
    models = {'model': main, 'second': main}
    store.save(MODELS, models)
    return models


async def chat(model: str, system: str, messages: list[dict], timeout: float) -> tuple[str, str]:
    """(answer, model that answered)."""
    if model == 'auto':
        model = (await auto_models())['model']
    if not model:
        raise ModelError('В каталоге шлюза нет моделей для чата')
    body = {
        'model': model,
        'messages': [
            {'role': 'system', 'content': [{'text': system}]},
            *({'role': m['role'], 'content': [{'text': m['content']}]} for m in messages),
        ],
        # Reasoning models behind the gateway otherwise spend the whole output limit before they answer.
        'model_options': {'reasoning': {'effort': 'off'}},
    }
    client, base = _client(timeout)
    async with client:
        response = await client.post(base + '/v2/chat/completions', json=body)
    if response.status_code != 200:
        raise ModelError(f'Шлюз моделей ответил HTTP {response.status_code}')
    answer = next((m for m in response.json().get('messages') or [] if m.get('role') == 'assistant'), {})
    return ''.join(part.get('text') or '' for part in answer.get('content') or []), model
