"""The bank's model gateway over mutual TLS (the work computer).

Where the certificates are: the files dropped into certs/ (url.txt, the certificate and key or one .p12,
password.txt, the bank's root certificate named ca* or root*). ~/.agent-lab/gateway.json (the archived Agent Lab's
format) and AGENT_LAB_GATEWAY_URL / _CERT_PATH / _KEY_PATH / _CA_PATH / _INSECURE take precedence when complete.
Protocol v2: POST /v2/chat/completions and GET /v1/models; the client certificate authenticates, no token.
"""

import asyncio
import codecs
import json
import os
import re
import ssl
import subprocess
import tempfile
import threading
from pathlib import Path

import httpx

from .. import store
from ..settings import CERTS, ROOT
from .errors import MalformedAnswer, ModelError, refused

FILE = Path(os.environ.get('AGENT_LAB_GATEWAY_FILE', '~/.agent-lab/gateway.json')).expanduser()
FORMAT = 'agent-lab-gateway-1'
MODELS = 'models.json'  # models chosen from the gateway's catalog, in data/
_ENV = {
    'url': 'AGENT_LAB_GATEWAY_URL',
    'cert': 'AGENT_LAB_GATEWAY_CERT_PATH',
    'key': 'AGENT_LAB_GATEWAY_KEY_PATH',
    'ca': 'AGENT_LAB_GATEWAY_CA_PATH',
}
# What the certificates cost once rather than on every call, shared by the server's threads: (what it was made from,
# the reason it failed or None, the result) for the converted bundle and the TLS context; one client per event loop.
_lock = threading.Lock()
_unpacked: tuple[tuple, str | None, tuple[Path, ...]] | None = None
_built: tuple[tuple, str | None, ssl.SSLContext | None] | None = None
_session: tuple[asyncio.AbstractEventLoop, ssl.SSLContext, httpx.AsyncClient] | None = None


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


def _password() -> bytes:
    """certs/password.txt as written, without its line break or a BOM; empty without the file."""
    path = CERTS / 'password.txt'
    if not path.exists():
        return b''
    return path.read_bytes().removeprefix(codecs.BOM_UTF8).strip()


def _unpack(bundle: Path) -> tuple[Path, Path]:
    """The bundle's PEM files, converted once per bundle and password: a renewed one is read again, a broken one is not
    tried again on every call."""
    global _unpacked
    password = _password()
    stamp = bundle.stat()
    key = (bundle, stamp.st_mtime_ns, stamp.st_size, password)
    with _lock:
        if _unpacked is None or _unpacked[0] != key or not all(path.exists() for path in _unpacked[2]):
            try:
                _unpacked = (key, None, _convert(bundle, password))
            except ModelError as error:
                _unpacked = (key, str(error), ())
        _, reason, files = _unpacked
    if reason:
        raise ModelError(reason)
    return files


def _convert(bundle: Path, password: bytes) -> tuple[Path, Path]:
    """Split a .p12/.pfx bundle into PEM files (certs/.converted, owner-only). openssl reads the password on stdin,
    never from its command line; a failed conversion leaves the previous files as they were."""
    cert = _openssl(bundle, password, '-clcerts', '-nokeys')
    key = _openssl(bundle, password, '-nocerts', '-nodes')
    if b'BEGIN CERTIFICATE' not in cert or b'PRIVATE KEY' not in key:
        raise ModelError(
            f'В {_named(bundle)} нет сертификата клиента с ключом: '
            'попросите выпустить .p12/.pfx заново или положите в certs/ сертификат и ключ в PEM'
        )
    out = CERTS / '.converted'
    try:
        out.mkdir(mode=0o700, exist_ok=True)
        _replace(out / 'client.pem', cert)
        _replace(out / 'client.key', key)
    except OSError as error:
        raise ModelError(
            f'Сертификат из {_named(bundle)} не записывается в {_named(out)} ({error.strerror}): '
            'проверьте место на диске и права на папку'
        ) from error
    return out / 'client.pem', out / 'client.key'


def _openssl(bundle: Path, password: bytes, *args: str) -> bytes:
    """One part of the bundle in PEM. A bundle exported by older Windows (RC2) opens under OpenSSL 3 only with -legacy;
    what went wrong is told in words, never with the command line."""
    for legacy in ((), ('-legacy',)):
        command = ['openssl', 'pkcs12', *legacy, '-in', str(bundle), *args, '-passin', 'stdin']
        try:
            done = subprocess.run(command, input=password + b'\n', capture_output=True, timeout=60, check=False)
        except FileNotFoundError:
            raise ModelError(
                f'Чтобы открыть {_named(bundle)}, нужна программа openssl, а её на компьютере нет: '
                'установите OpenSSL или положите в certs/ сертификат и ключ в PEM'
            ) from None
        except (OSError, subprocess.TimeoutExpired) as error:
            raise ModelError(f'openssl не открыл {_named(bundle)}: {type(error).__name__}') from None
        if done.returncode == 0:
            return done.stdout
        failure = done.stderr.decode(errors='replace')
        if 'unsupported' not in failure:
            break
    if 'invalid password' in failure.lower():
        where = _named(CERTS / 'password.txt')
        if not password:
            raise ModelError(f'{_named(bundle)} закрыт паролем: впишите его в {where}')
        raise ModelError(f'{_named(bundle)} не открылся: неверный пароль в {where}')
    if legacy:
        raise ModelError(
            f'{_named(bundle)} в старом формате (RC2), а OpenSSL на этом компьютере открывает его только с модулем '
            'legacy: пересохраните сертификат в современном формате (AES) или положите в certs/ сертификат и ключ в PEM'
        )
    raise ModelError(f'openssl не открыл {_named(bundle)} (код {done.returncode}): проверьте, что это целый .p12/.pfx')


def _replace(path: Path, data: bytes) -> None:
    """Write beside the file, then rename over it: a reader never sees half a key, a failure leaves the old file."""
    descriptor, temporary = tempfile.mkstemp(dir=path.parent, prefix=f'.{path.name}.')  # owner-only
    try:
        with os.fdopen(descriptor, 'wb') as file:
            file.write(data)
        os.replace(temporary, path)
    except BaseException:
        Path(temporary).unlink(missing_ok=True)
        raise


def _named(path: Path) -> str:
    """A file the way the person finds it: certs/… inside the project, the full path elsewhere."""
    return str(path.relative_to(ROOT)) if path.is_relative_to(ROOT) else str(path)


async def _client() -> tuple[httpx.AsyncClient, str]:
    """One long-lived client per event loop (the CLI may run several), a new one when the certificates change. certs/
    is read in a worker thread, so a renewed bundle is unpacked off the event loop."""
    global _session
    context, base = await asyncio.to_thread(_connection)
    loop = asyncio.get_running_loop()
    if _session is None or _session[0] is not loop or _session[1] is not context:
        # The previous client finishes the calls it carries; the gateway closes its idle connections.
        _session = (loop, context, httpx.AsyncClient(verify=context))
    return _session[2], base


def _connection() -> tuple[ssl.SSLContext, str]:
    settings = config()
    if not settings:
        raise ModelError('Шлюз моделей не настроен: положите url.txt, сертификат и ключ в папку certs/')
    return _context(settings), settings['url']


def _context(settings: dict) -> ssl.SSLContext:
    """TLS with the client certificate, built again only when its files or password change."""
    global _built
    password = _password()
    key = (*(_stamp(settings.get(name)) for name in ('cert', 'key', 'ca')), password, settings.get('insecure'))
    with _lock:
        if _built is None or _built[0] != key:
            try:
                _built = (key, None, _tls(settings, password))
            except ModelError as error:
                _built = (key, str(error), None)
        _, reason, context = _built
    if reason:
        raise ModelError(reason)
    return context


def _tls(settings: dict, password: bytes) -> ssl.SSLContext:
    try:
        context = ssl.create_default_context(cafile=settings.get('ca') or None)
        context.load_cert_chain(settings['cert'], settings['key'], password=password or None)
    except (OSError, ssl.SSLError) as error:
        raise ModelError(f'Сертификат, ключ или CA шлюза не читаются: {type(error).__name__}') from error
    if settings.get('insecure'):
        context.check_hostname = False
        context.verify_mode = ssl.CERT_NONE
    return context


def _stamp(path: str | None) -> tuple:
    """A file's path, time and size: what changes when it is replaced."""
    try:
        status = os.stat(path) if path else None
    except OSError:
        status = None
    return (path, status.st_mtime_ns, status.st_size) if status else (path,)


async def catalog(timeout: httpx.Timeout | float = 30) -> list[str]:
    """Chat models the gateway offers."""
    client, base = await _client()
    response = await client.get(base + '/v1/models', timeout=timeout)
    if response.status_code != 200:
        raise refused('Шлюз не отдал каталог моделей:', response)
    try:
        data = response.json()
    except ValueError as error:
        raise ModelError('Шлюз вернул каталог не в JSON') from error
    if not isinstance(data, dict) or not isinstance(data.get('data'), list):
        raise ModelError('В каталоге шлюза нет списка data')
    models = data['data']
    if not all(isinstance(model, dict) and isinstance(model.get('id'), str) for model in models):
        raise ModelError('Неверный формат записи модели в каталоге шлюза')
    return [model['id'] for model in models if model.get('type', 'chat') == 'chat']


def chosen_models() -> dict:
    return store.load(MODELS, {}) or {}


async def auto_models(timeout: httpx.Timeout | float = 30) -> dict:
    """Unless chosen: the newest full GLM in the catalog, for the judge, the simulator and the second judge."""
    models = chosen_models()
    if models.get('model'):
        return models
    names = await catalog(timeout)
    glm = [m for m in names if 'glm' in m.lower()]
    full = [m for m in glm if not any(light in m.lower() for light in ('flash', 'air', 'mini'))]
    ranked = sorted(full or glm, reverse=True)  # a full model (glm-5.2) over a light one (glm-5.3-flash)
    main = ranked[0] if ranked else (names[0] if names else None)
    models = {'model': main, 'second': main}
    store.save(MODELS, models)
    return models


async def chat(model: str, system: str, messages: list[dict], timeout: httpx.Timeout) -> tuple[str, str]:
    """(answer, model that answered)."""
    if model == 'auto':
        model = (await auto_models(timeout))['model']
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
    client, base = await _client()
    response = await client.post(base + '/v2/chat/completions', json=body, timeout=timeout)
    if response.status_code != 200:
        raise refused('Шлюз моделей ответил', response)
    try:
        data = response.json()
    except ValueError as error:
        raise MalformedAnswer('Шлюз вернул ответ не в JSON') from error
    if not isinstance(data, dict) or not isinstance(data.get('messages'), list):
        raise MalformedAnswer('В ответе шлюза нет списка messages')
    if not all(isinstance(message, dict) for message in data['messages']):
        raise MalformedAnswer('Неверный формат сообщения шлюза')
    answer = next((message for message in data['messages'] if message.get('role') == 'assistant'), None)
    if answer is None or not isinstance(answer.get('content'), list):
        raise MalformedAnswer('В ответе шлюза нет текста assistant')
    parts = answer['content']
    if not all(isinstance(part, dict) and isinstance(part.get('text'), str) for part in parts):
        raise MalformedAnswer('Текст ответа шлюза должен быть строкой')
    label = data.get('model', model)
    if not isinstance(label, str) or not label.strip():
        raise MalformedAnswer('Имя ответившей модели шлюза должно быть строкой')
    return ''.join(part['text'] for part in parts), label
