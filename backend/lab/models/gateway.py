"""The bank's model gateway over mutual TLS (the work computer).

Where the certificates are: the files dropped into certs/ (url.txt, the certificate and key or one .p12,
password.txt, the bank's root certificate named ca* or root*). ~/.agent-lab/gateway.json (the archived Agent Lab's
format) and AGENT_LAB_GATEWAY_URL / _CERT_PATH / _KEY_PATH / _CA_PATH / _INSECURE take precedence when complete.
Protocol v2: POST /v2/chat/completions and GET /v1/models; the client certificate authenticates, no token.
Set up but broken, it stays the backend: every call fails with what to fix (problem), no conversation goes elsewhere.
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

from .. import config, store
from ..config import ROOT
from .completion import Completion, usage
from .errors import MalformedAnswer, ModelError, refused

FORMAT = 'agent-lab-gateway-1'
MODELS = 'models.json'  # models chosen from the gateway's catalog, in data/
# What the certificates cost once rather than on every call, shared by the server's threads: (what it was made from,
# the reason it failed or None, the result) for the converted bundle and the TLS context; one client per event loop.
_lock = threading.Lock()
_unpacked: tuple[tuple, str | None, tuple[Path, ...]] | None = None
_built: tuple[tuple, str | None, ssl.SSLContext | None] | None = None
_session: tuple[asyncio.AbstractEventLoop, ssl.SSLContext, httpx.AsyncClient] | None = None


def settings() -> dict | None:
    """url, cert, key, ca and insecure; None when the gateway is not set up. Set up but unusable (an empty url.txt, no
    certificate, a file that cannot be read, a bundle that does not open) is a ModelError saying what to fix: the only
    error it raises. The settings file first, the Lab's settings over it (AGENT_LAB_GATEWAY_*), certs/ when neither is
    complete."""
    lab = config.current()
    try:
        found = _from_file(lab.gateway_file)
        given = {'url': lab.gateway_url, 'cert': lab.gateway_cert, 'key': lab.gateway_key, 'ca': lab.gateway_ca}
        found.update({field: value for field, value in given.items() if value})
        if lab.gateway_insecure is not None:
            found['insecure'] = lab.gateway_insecure
        if not _complete(found) and lab.certs:
            found = _from_certs_folder(lab.certs) or found
    except OSError as error:
        raise ModelError(_unreadable(error)) from error
    if not _complete(found):
        return None
    found['url'] = re.sub(r'/v[12]$', '', found['url'].rstrip('/'))
    return found


def configured() -> bool:
    """Set up: certs/url.txt, or a complete settings file or environment. A broken setup is still the gateway: its calls
    fail with the reason (problem) rather than the conversations going to another backend."""
    try:
        return settings() is not None
    except ModelError:
        return True


def problem() -> str | None:
    """Why the gateway that is set up cannot be used, in words for «Настройки» and bin/start.sh; None when it can."""
    try:
        found = settings()
        if found:
            _context(found)
    except ModelError as error:
        return str(error)
    return None


def _complete(found: dict) -> bool:
    return bool(found.get('url') and found.get('cert') and found.get('key'))


def _from_file(file: Path | None) -> dict:
    """The archived Agent Lab's settings file, when there is one."""
    if file is None or not file.exists():
        return {}
    try:
        data = json.loads(file.read_text(encoding='utf-8'))
    except (OSError, ValueError) as error:
        raise ModelError(f'Файл настройки шлюза {file} не читается. Исправьте или удалите его.') from error
    if not isinstance(data, dict) or data.get('format') != FORMAT:
        raise ModelError(f'Файл настройки шлюза {file} в неизвестном формате. Исправьте или удалите его.')
    found = {
        'url': data.get('url'),
        'cert': data.get('certPath'),
        'key': data.get('keyPath'),
        'ca': data.get('caPath'),
    }
    if not all(value is None or isinstance(value, str) for value in found.values()):
        raise ModelError(f'В файле настройки шлюза {file} url, certPath, keyPath и caPath должны быть строками.')
    return {**found, 'insecure': bool(data.get('insecure'))}


def _from_certs_folder(certs: Path) -> dict | None:
    """certs/: url.txt, a client certificate and key (PEM, or one .p12/.pfx with password.txt), and the bank's root
    certificate named ca* or root* when the gateway needs it. Without url.txt the gateway is not set up; with it,
    whatever is missing is a ModelError."""
    if not (certs / 'url.txt').exists():
        return None
    url = _url(certs)
    files = [f for f in certs.iterdir() if f.is_file()]
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
        raise ModelError(
            f'В {_named(certs)} нет сертификата и ключа шлюза. Положите их в PEM (.pem или .crt и .key) '
            'или один .p12/.pfx с паролем в password.txt.'
        )
    return {'url': url, 'cert': str(cert), 'key': str(key), 'ca': str(ca) if ca else None, 'insecure': False}


def _url(certs: Path) -> str:
    """The gateway's address: the first line of certs/url.txt."""
    path = certs / 'url.txt'
    lines = [line.strip() for line in path.read_text(encoding='utf-8-sig', errors='replace').splitlines()]
    url = next((line for line in lines if line), '')
    if not url:
        raise ModelError(f'{_named(path)} пустой. Впишите в него адрес шлюза моделей (https://…).')
    try:
        valid = url.startswith(('https://', 'http://')) and bool(httpx.URL(url).host)
    except httpx.InvalidURL:
        valid = False
    if not valid:
        raise ModelError(f'В {_named(path)} не адрес шлюза. Нужна одна строка вида https://адрес-шлюза.')
    return url


def _password() -> bytes:
    """certs/password.txt as written, without its line break or a BOM: the password of the bundle and of the key,
    wherever they lie. Empty without the file, or without certs/ in the Lab's settings."""
    certs = config.current().certs
    path = certs / 'password.txt' if certs else None
    try:
        return path.read_bytes().removeprefix(codecs.BOM_UTF8).strip() if path and path.exists() else b''
    except OSError as error:
        raise ModelError(_unreadable(error)) from error


def _unreadable(error: OSError) -> str:
    where = _named(Path(error.filename)) if error.filename else 'Файл в certs/'
    return f'{where} не читается ({error.strerror or type(error).__name__}). Проверьте, что файл на месте и доступен.'


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
            f'В {_named(bundle)} нет сертификата клиента с ключом. '
            'Попросите выпустить .p12/.pfx заново или положите в certs/ сертификат и ключ в PEM.'
        )
    out = bundle.parent / '.converted'
    try:
        out.mkdir(mode=0o700, exist_ok=True)
        _replace(out / 'client.pem', cert)
        _replace(out / 'client.key', key)
    except OSError as error:
        raise ModelError(
            f'Сертификат из {_named(bundle)} не записывается в {_named(out)} ({error.strerror}). '
            'Проверьте место на диске и права на папку.'
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
                f'Чтобы открыть {_named(bundle)}, нужна программа openssl, а её на компьютере нет. '
                'Установите OpenSSL или положите в certs/ сертификат и ключ в PEM.'
            ) from None
        except (OSError, subprocess.TimeoutExpired) as error:
            raise ModelError(f'openssl не открыл {_named(bundle)} ({type(error).__name__}).') from None
        if done.returncode == 0:
            return done.stdout
        failure = done.stderr.decode(errors='replace')
        if 'unsupported' not in failure:
            break
    if 'invalid password' in failure.lower():
        where = _named(bundle.parent / 'password.txt')
        if not password:
            raise ModelError(f'{_named(bundle)} закрыт паролем. Впишите его в {where}.')
        raise ModelError(f'{_named(bundle)} не открылся: неверный пароль. Исправьте его в {where}.')
    if legacy:
        raise ModelError(
            f'{_named(bundle)} в старом формате (RC2), а OpenSSL на этом компьютере открывает его только с модулем '
            'legacy. Пересохраните сертификат в формате AES или положите в certs/ сертификат и ключ в PEM.'
        )
    raise ModelError(f'openssl не открыл {_named(bundle)} (код {done.returncode}). Проверьте, что файл не повреждён.')


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
    found = settings()
    if not found:
        raise ModelError('Шлюз моделей не настроен. Положите url.txt, сертификат и ключ в папку certs/.')
    return _context(found), found['url']


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
    """The password is passed even when empty: without one, OpenSSL would ask for it on the terminal and hold every
    call."""
    ca, cert, key = settings.get('ca'), Path(settings['cert']), Path(settings['key'])
    try:
        context = ssl.create_default_context(cafile=ca or None)
    except (OSError, ssl.SSLError) as error:
        where = _named(Path(ca)) if ca else 'системные'
        raise ModelError(
            f'Корневой сертификат шлюза ({where}) не читается ({type(error).__name__}). Нужен сертификат банка в PEM.'
        ) from error
    try:
        context.load_cert_chain(cert, key, password=password)
    except (OSError, ssl.SSLError) as error:
        raise ModelError(
            f'Сертификат {_named(cert)} и ключ {_named(key)} не читаются или не подходят друг к другу '
            f'({type(error).__name__}). Нужна пара одного выпуска. '
            'Если у ключа есть пароль, впишите его в password.txt.'
        ) from error
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
        raise refused('Шлюз не отдал каталог моделей', response)
    try:
        data = response.json()
    except ValueError as error:
        raise ModelError('Шлюз отдал каталог не в JSON.') from error
    if not isinstance(data, dict) or not isinstance(data.get('data'), list):
        raise ModelError('В каталоге шлюза нет списка data.')
    models = data['data']
    if not all(isinstance(model, dict) and isinstance(model.get('id'), str) for model in models):
        raise ModelError('Запись модели в каталоге шлюза в неизвестном формате.')
    return [model['id'] for model in models if model.get('type', 'chat') == 'chat']


def chosen_models() -> dict:
    return store.load(MODELS, {}) or {}


def _version(name: str) -> tuple[int, ...]:
    """The version after «glm», numbers compared as numbers: glm-5.10 is newer than glm-5.9."""
    found = re.search(r'glm\D*?(\d+(?:\.\d+)*)', name.lower())
    return tuple(int(part) for part in found.group(1).split('.')) if found else ()


async def auto_models(timeout: httpx.Timeout | float = 30) -> dict:
    """Unless chosen: the newest full GLM in the catalog, for the judge, the simulator and the second judge."""
    models = chosen_models()
    if models.get('model'):
        return models
    names = await catalog(timeout)
    glm = [m for m in names if 'glm' in m.lower()]
    full = [m for m in glm if not any(light in m.lower() for light in ('flash', 'air', 'mini'))]
    # A full model (glm-5.2) over a light one (glm-5.3-flash), the newest version first.
    ranked = sorted(full or glm, key=lambda name: (_version(name), name), reverse=True)
    main = ranked[0] if ranked else (names[0] if names else None)
    models = {'model': main, 'second': main}
    store.save(MODELS, models)
    return models


async def chat(model: str, system: str, messages: list[dict], timeout: httpx.Timeout) -> Completion:
    """The answer, the model that gave it, and its tokens and cost when the gateway names them."""
    if model == 'auto':
        model = (await auto_models(timeout))['model']
    if not model:
        raise ModelError('В каталоге шлюза нет моделей для чата.')
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
        raise refused('Шлюз моделей ответил ошибкой', response)
    try:
        data = response.json()
    except ValueError as error:
        raise MalformedAnswer('Шлюз ответил не в JSON.') from error
    if not isinstance(data, dict) or not isinstance(data.get('messages'), list):
        raise MalformedAnswer('В ответе шлюза нет списка messages.')
    if not all(isinstance(message, dict) for message in data['messages']):
        raise MalformedAnswer('Сообщение шлюза в неизвестном формате.')
    answer = next((message for message in data['messages'] if message.get('role') == 'assistant'), None)
    if answer is None or not isinstance(answer.get('content'), list):
        raise MalformedAnswer('В ответе шлюза нет текста assistant.')
    parts = answer['content']
    if not all(isinstance(part, dict) and isinstance(part.get('text'), str) for part in parts):
        raise MalformedAnswer('Текст ответа шлюза не строка.')
    label = data.get('model', model)
    if not isinstance(label, str) or not label.strip():
        raise MalformedAnswer('Имя модели в ответе шлюза не строка.')
    return Completion(''.join(part['text'] for part in parts), label, **usage(data))
