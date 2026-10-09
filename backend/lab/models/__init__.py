"""The models the Lab asks: where they are, one way to ask them, and the journal of every call.

Two backends, chosen as the Lab starts (endpoints):
- the bank's model gateway (gateway.py) when its certificates are in certs/: the work computer; LAB_MODEL names its
  model, else the newest GLM of its catalog; a second judge only with LAB_SECOND_MODEL;
- an OpenAI-compatible endpoint otherwise (openai_compatible.py): LAB_MODEL_URL / LAB_MODEL_KEY / LAB_MODEL, and
  without LAB_MODEL_URL OpenRouter itself, with its key in OPENROUTER_API_KEY. A second judge of another vendor only
  with LAB_SECOND_MODEL (+ LAB_SECOND_URL / LAB_SECOND_KEY). It re-checks every verdict; its actual model is recorded in
  that result. Without it, or when it is the main model again, there is no second check (second_judge).

chat() is the one way to ask: within the limit of concurrent calls (concurrency: one by default, more on OpenRouter),
asked again when another try may pass (no connection, 5xx; over the limit of requests, 429, for longer), and every try
written to the agent's journal of calls with the role that asks, the version of its instructions and what the calls are
about (about): a check, a run, a deck. The journal keeps no conversation: the texts are in the results already. The
roles (roles/) ask through it.
"""

import asyncio
import functools
import logging
import random
import sqlite3
import time
from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from urllib.parse import urlsplit

import httpx
from pydantic import SecretStr, ValidationError

from .. import config, storage
from . import gateway, openai_compatible
from .completion import Completion
from .errors import MalformedAnswer, ModelError, RateLimited, refused
from .openai_compatible import NO_KEY, OPENROUTER

GATEWAY = 'gateway'
Endpoint = tuple[str, str]  # (base URL or GATEWAY, model)
DEFAULT_MODEL = 'z-ai/glm-5.3'
ATTEMPTS = 3  # tries of a call that may pass later; after a read timeout, one more try only
CONNECT_TIMEOUT = 10  # seconds: an unreachable model fails fast, while an answer may take the whole read timeout
PAUSE = 2  # seconds before the second try, doubled before each next one, plus up to as much again at random
MAX_PAUSE = 60  # a longer Retry-After is cut to this, and so is a pause that doubled past it
# Over its limit of requests (429) a model is waited for longer, as the limit passes with time: up to LIMIT_ATTEMPTS
# tries, the pause it asks for or one doubling from LIMIT_PAUSE, about four minutes in all. Then the work stops
# (RateLimited), whatever it did kept.
LIMIT_ATTEMPTS = 8
LIMIT_PAUSE = 5
# Work refused before it starts, while the models cannot be asked (ensure_set_up).
NOT_SET_UP = 'Модели не настроены: {}. Подробности в «Настройках».'
RATE_LIMITED = (
    'Модель не принимает запросы: превышен лимит (HTTP 429). Lab подождал и повторил запрос {} раз, но лимит не снят. '
    'Подождите несколько минут и продолжите: сделанное сохранено.'
)
# Calls at once without LAB_MODEL_CONCURRENCY (concurrency). OpenRouter spreads them over many providers and takes far
# more: a hundred calls of the judge at once got no refusal. The bank's gateway limits requests, and calls side by side
# only meet its limit sooner; an endpoint of one's own is not known to take more.
OPENROUTER_CONCURRENCY = 32
CONCURRENCY = 1
# No connection, a dropped one, or no answer in time: the next try may pass.
_TRANSIENT = (httpx.TimeoutException, httpx.NetworkError, httpx.RemoteProtocolError)
# No connection, or no answer in time: what is wrong in plain words, the exception's name for support, and where to
# look. «Настройки» check the models themselves (check): there the advice is left out.
SEE_SETTINGS = 'Проверьте её в разделе «Настройки».'
UNREACHABLE = 'Модель недоступна ({}). ' + SEE_SETTINGS
# How a try ended, in the journal: an answer, an answer nobody could use, a refusal with an HTTP status, no answer.
ANSWERED, UNUSABLE, REFUSED, FAILED = 'answered', 'unusable', 'refused', 'failed'
log = logging.getLogger(__name__)


@dataclass(frozen=True)
class Endpoints:
    """Where the models are by the Lab's settings: the main one, the second judge's (the main one again unless a second
    is named), and the key each is sent with."""

    main: Endpoint
    second: Endpoint
    main_key: str | None
    second_key: str | None


@dataclass(frozen=True)
class Call:
    """What a call is for, in the journal: the role that asks and the version of its instructions (roles.Role)."""

    role: str
    version: str | None = None


@dataclass(frozen=True)
class Reply:
    """A model's answer in words, the model that gave it (kept together across concurrent calls), and its line in the
    journal (None when the journal could not take it)."""

    text: str
    model: str
    call: int | None = None


# What the calls are about, in the journal: set by the process that makes them (about).
_SUBJECT: ContextVar[str | None] = ContextVar('subject', default=None)


@contextmanager
def about(subject: str) -> Iterator[None]:
    """The calls made inside are about this: «check:<id>», «run:<id>», «deck:<check>»."""
    token = _SUBJECT.set(subject)
    try:
        yield
    finally:
        _SUBJECT.reset(token)


def endpoints() -> Endpoints:
    return _endpoints(config.current())


@functools.cache
def _endpoints(settings: config.Settings) -> Endpoints:
    """Chosen once for the settings the Lab started with (they are the current ones here): certificates dropped into
    certs/ later take effect when the Lab starts again."""
    openrouter_key = _secret(settings.openrouter_key)
    if not settings.model_url and gateway.configured():
        # 'auto': the newest GLM in the gateway's catalog, chosen per agent at its first call (gateway.auto_models).
        # Nothing is read from the agents' databases here: choosing the models never opens or sets up a database.
        main: Endpoint = (GATEWAY, settings.model or 'auto')
        # A second judge only when named, as on the other path: the gateway's catalog never adds one by itself.
        second = (GATEWAY, settings.second_model) if settings.second_model else main
    else:
        main = ((settings.model_url or OPENROUTER).rstrip('/'), settings.model or DEFAULT_MODEL)
        # One model by default, as on the work computer; a second vendor only when named. It goes where the main one
        # goes unless LAB_SECOND_URL says otherwise.
        second_url = (settings.second_url or main[0]).rstrip('/')
        second = (second_url, settings.second_model) if settings.second_model else main
    main_key = _secret(settings.model_key) or (openrouter_key if main[0] == OPENROUTER else None)
    # The main key goes only to the main model's address: elsewhere the second judge has a key of its own, OpenRouter's
    # key only OpenRouter.
    second_key = _secret(settings.second_key) or (
        main_key if second[0] == main[0] else openrouter_key if second[0] == OPENROUTER else None
    )
    return Endpoints(main, second, main_key, second_key)


def _secret(value: SecretStr | None) -> str | None:
    return value.get_secret_value() if value else None


def main_model() -> str:
    """The main model as configured: 'auto' until the gateway's catalog names one (models_used, _names)."""
    return endpoints().main[1]


def concurrency() -> int:
    """How many calls go to the models at once: LAB_MODEL_CONCURRENCY when it is set, else OPENROUTER_CONCURRENCY on
    OpenRouter and CONCURRENCY elsewhere."""
    settings = config.current()
    if settings.concurrency:
        return settings.concurrency
    return OPENROUTER_CONCURRENCY if endpoints().main[0] == OPENROUTER else CONCURRENCY


_gate: tuple[asyncio.AbstractEventLoop, asyncio.Semaphore] | None = None


def _limit() -> asyncio.Semaphore:
    """One limiter per event loop: the CLI may run several asyncio.run calls in one process."""
    global _gate
    loop = asyncio.get_running_loop()
    if _gate is None or _gate[0] is not loop:
        _gate = (loop, asyncio.Semaphore(concurrency()))
    return _gate[1]


async def chat(
    system: str,
    messages: list[dict] | str,
    *,
    json_mode: bool = False,
    timeout: float = 240,
    endpoint: Endpoint | None = None,
    attempts: int = ATTEMPTS,
    call: Call | None = None,
) -> Reply:
    """One answer in words. No connection and 5xx are asked again, up to `attempts` tries, after the pause the model
    asked for or a doubling one; a model over its limit of requests (429) longer, up to LIMIT_ATTEMPTS tries, then
    RateLimited — unless the caller asked for one try only; a read timeout once only, as the model may have done (and
    billed) the work; nothing else. Every try goes to the journal."""
    base, model = endpoint or endpoints().main
    if isinstance(messages, str):
        messages = [{'role': 'user', 'content': messages}]
    limits = httpx.Timeout(timeout, connect=CONNECT_TIMEOUT)
    attempt = timeouts = 0
    while True:
        attempt += 1
        started, clock = storage.now(), time.monotonic()
        try:
            done = await _ask(base, model, system, messages, json_mode, limits)
            if not done.text.strip():
                raise MalformedAnswer('Модель вернула пустой ответ.')
        except ModelError as error:
            await _journal(call, base, model, started, clock, error=error)
            timeouts += isinstance(error.__cause__, httpx.ReadTimeout)
            limited = error.status == 429 and attempts > 1
            tries = max(attempts, LIMIT_ATTEMPTS) if limited else attempts
            if not error.retryable or attempt >= tries or timeouts > 1:
                if limited:
                    raise RateLimited(
                        RATE_LIMITED.format(attempt), status=429, retryable=True, detail=str(error)
                    ) from error
                raise
            await asyncio.sleep(_pause(attempt, error.retry_after, limited))
            continue
        line = await _journal(call, base, model, started, clock, done=done)
        return Reply(done.text.strip(), done.model, line)


async def _ask(
    base: str, model: str, system: str, messages: list[dict], json_mode: bool, timeout: httpx.Timeout
) -> Completion:
    """One try, within the concurrency limit; what went wrong on the way becomes a ModelError."""
    try:
        async with _limit():
            if base == GATEWAY:
                return await gateway.chat(model, system, messages, timeout)
            key = _key((base, model))
            return await openai_compatible.chat(base, model, key, system, messages, json_mode, timeout)
    except _TRANSIENT as error:
        raise ModelError(UNREACHABLE.format(type(error).__name__), retryable=True) from error
    except httpx.HTTPError as error:
        raise ModelError(UNREACHABLE.format(type(error).__name__)) from error
    except httpx.InvalidURL as error:  # not an HTTPError: a typo in the address
        setting = 'certs/url.txt' if base == GATEWAY else 'LAB_MODEL_URL и LAB_SECOND_URL'
        raise ModelError(f'Адрес модели записан с ошибкой ({error}). Проверьте {setting}.') from error


def _key(endpoint: Endpoint) -> str | None:
    """The key for this endpoint's address: the main key never goes to another host."""
    found = endpoints()
    if endpoint == found.main:
        return found.main_key
    if endpoint == found.second:
        return found.second_key
    return found.main_key if endpoint[0] == found.main[0] else None


def _pause(attempt: int, retry_after: float | None, limited: bool = False) -> float:
    """Seconds before the next try: the model's own Retry-After up to MAX_PAUSE, else a doubling pause with jitter, so
    the calls that failed together do not all come back at once; over the limit of requests, from a longer first one."""
    if retry_after is not None:
        return min(retry_after, MAX_PAUSE)
    first = LIMIT_PAUSE if limited else PAUSE
    return min(first * 2 ** (attempt - 1), MAX_PAUSE) + random.uniform(0, first)


async def _journal(
    call: Call | None,
    base: str,
    model: str,
    started: str,
    clock: float,
    *,
    done: Completion | None = None,
    error: ModelError | None = None,
) -> int | None:
    """One try in the journal of the agent's calls; never the conversation. A journal that cannot be written costs the
    line, never the call."""
    if error is None:
        outcome = ANSWERED
    else:
        outcome = UNUSABLE if isinstance(error, MalformedAnswer) else REFUSED if error.status else FAILED
    line = {
        'at': started,
        'role': call.role if call else None,
        'version': call.version if call else None,
        'subject': _SUBJECT.get(),
        'model': model,
        'answeredBy': done.model if done else None,
        'via': _via(base),
        'ms': round(1000 * (time.monotonic() - clock)),
        'inputTokens': done.input_tokens if done else None,
        'outputTokens': done.output_tokens if done else None,
        'cost': done.cost if done else None,
        'outcome': outcome,
        'status': error.status if error else None,
        'detail': str(error) if error else None,
    }
    try:
        return await asyncio.to_thread(storage.calls.add, line)
    except sqlite3.Error as failure:
        log.warning('Вызов модели не записан в журнал: %s', failure)
        return None


async def unusable(reply: Reply, error: Exception) -> None:
    """The answer of this try could not be used (roles.ask): its line in the journal says so, and why, without the
    answer's words."""
    if reply.call is None:
        return
    try:
        await asyncio.to_thread(storage.calls.outcome, reply.call, UNUSABLE, detail(error))
    except sqlite3.Error as failure:
        log.warning('Вызов модели не записан в журнал: %s', failure)


def detail(error: BaseException | None) -> str:
    """What went wrong with an answer, for the journal and the server log: the parser's words, never the answer's (a
    Pydantic error would quote the answer, and the answer quotes the conversation)."""
    if isinstance(error, ValidationError):
        found = '; '.join(
            f'{".".join(map(str, item["loc"])) or "answer"}: {item["msg"]}'
            for item in error.errors(include_input=False, include_url=False)
        )
        return f'ValidationError: {found}'[:300]
    return f'{type(error).__name__}: {str(error)[:200]}'


def models_used(records: list[dict]) -> str:
    """Actual models recorded by a completed operation; configured model when no call completed."""
    names = dict.fromkeys(record['model'] for record in records if record.get('model'))
    return ', '.join(names) or main_model()


def _names() -> tuple[str | None, str | None]:
    """The main and the second model by name, as configured or chosen from the gateway's catalog."""
    found = endpoints()
    chosen = gateway.chosen_models() if found.main[0] == GATEWAY else {}
    main = chosen.get('model') if found.main[1] == 'auto' else found.main[1]
    second = chosen.get('second') if found.second[1] == 'auto' else found.second[1]
    return main, second


def second_judge() -> Endpoint | None:
    """The second judge, only when it is another model. The same model asked twice mostly agrees with itself, which
    says nothing about being right (Kim et al. 2025): with one model, trust comes from a person's answers."""
    main, second = _names()
    found = endpoints()
    if found.second == found.main or (second is not None and second == main):
        return None
    return found.second


def describe() -> dict:
    """Which models judge and play the customer, and where the conversations go (secondVia: where the second judge's
    go, when elsewhere); no second when only one model is available; problem: why they cannot be used now."""
    main, second = _names()
    judge = second_judge()
    via, second_via = _via(endpoints().main[0]), _via(judge[0]) if judge else None
    return {
        'via': via,
        'main': main,
        'second': second if judge else None,
        'secondVia': second_via if second_via != via else None,
        'problem': problem(),
    }


def problem() -> str | None:
    """Why no conversation can be checked now: the bank's gateway, set up, does not work, or OpenRouter has no key."""
    found = endpoints()
    if found.main[0] == GATEWAY:
        return gateway.problem()
    return NO_KEY if found.main[0] == OPENROUTER and not found.main_key else None


def ensure_set_up() -> None:
    """Work that asks the models starts only while they can be asked: before any of it is done, a ValueError says
    why they cannot (problem) and where to look (NOT_SET_UP)."""
    found = problem()
    if found:
        raise ValueError(NOT_SET_UP.format(found.rstrip('.')))


def _via(base: str) -> str:
    """The bank's gateway, OpenRouter, or the endpoint's host[:port]."""
    if base == GATEWAY:
        return 'шлюз банка'
    if base == OPENROUTER:
        return 'OpenRouter'
    try:
        address = urlsplit(base).netloc or base
    except ValueError:
        address = base
    return address.rpartition('@')[2]  # never a user or a password written into the address


async def check(endpoint: Endpoint) -> dict:
    """One short call, tried once: does this model answer. The person waits for it, so what is wrong is said at once."""
    try:
        await chat(
            'Ответь одним словом.',
            'Проверка связи: ответь «готов».',
            timeout=90,
            endpoint=endpoint,
            attempts=1,
            call=Call('connection'),
        )
    except ModelError as error:
        return {'ok': False, 'error': str(error).removesuffix(' ' + SEE_SETTINGS)}
    return {'ok': True}


__all__ = [
    'GATEWAY',
    'NO_KEY',
    'OPENROUTER',
    'Call',
    'Endpoint',
    'Endpoints',
    'MalformedAnswer',
    'ModelError',
    'RateLimited',
    'Reply',
    'about',
    'chat',
    'check',
    'concurrency',
    'describe',
    'detail',
    'endpoints',
    'ensure_set_up',
    'gateway',
    'main_model',
    'models_used',
    'problem',
    'refused',
    'second_judge',
    'unusable',
]
