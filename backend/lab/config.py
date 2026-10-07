"""The Lab's settings: where it keeps its data, which models it asks and how, where the agent's stand is.

They are read from the environment once, when the Lab starts (Settings.from_environment: the app, a command), and reach
the code through the context of each request and job (current), as the agent a request works in does. Nothing reads
the environment at import: a test builds the settings it needs, and settings built without the environment connect to
nothing (no certificates, no gateway file, no key) unless the test names it.
"""

import os
from collections.abc import Iterable, Iterator, Mapping
from contextlib import contextmanager
from contextvars import ContextVar
from pathlib import Path

from pydantic import BaseModel, ConfigDict, Field, SecretStr, field_validator

ROOT = Path(__file__).resolve().parents[2]
# Where a Lab started from the environment keeps what the environment does not name; relative to ROOT.
PLACES = {
    'LAB_DATA': 'data',
    'LAB_CERTS': 'certs',
    'LAB_FRONTEND': 'frontend/dist',
    'AGENT_LAB_GATEWAY_FILE': '~/.agent-lab/gateway.json',
}


class Settings(BaseModel):
    """Each setting by the environment variable that sets it (its alias); a test names them by field."""

    model_config = ConfigDict(frozen=True, populate_by_name=True, extra='ignore')

    # Logs, sources, cards, runs and page settings: real bank data, git-ignored, never in the repository.
    data: Path = Field(alias='LAB_DATA')
    # Certificates of the bank's model gateway, dropped in by hand on the work computer (models/gateway.py).
    certs: Path | None = Field(None, alias='LAB_CERTS')
    # The built pages; without them the Lab answers its API only.
    frontend: Path | None = Field(None, alias='LAB_FRONTEND')
    # Names of this computer a browser may open the Lab by, besides 127.0.0.1 and localhost (app.py).
    allowed_hosts: frozenset[str] = Field(frozenset(), alias='LAB_ALLOWED_HOSTS')

    # The agent's stand: the mocks of the bank's systems, how long a reply may take, the IFT stand's system id.
    mock_url: str = Field('http://127.0.0.1:8090', alias='AGENT_LAB_MOCK_URL')
    agent_timeout: float = Field(180, gt=0, alias='LAB_AGENT_TIMEOUT')
    prod_system_id: str = Field('6ba7b810-9dad-11d1-80b4-00c04fd430c8', alias='LAB_PROD_SYSTEM_ID')
    # The replay service on the stand (aigw-local replay/) for «Повтор разговоров», its origin http://host:port; without
    # it a replay is not offered that way (agents.replay_targets).
    replay_url: str = Field('', alias='LAB_REPLAY_URL')

    # The models (models/__init__.py): an OpenAI-compatible endpoint, else the bank's gateway when it is set up, else
    # OpenRouter; a second judge only when named.
    model_url: str | None = Field(None, alias='LAB_MODEL_URL')
    model: str | None = Field(None, alias='LAB_MODEL')
    model_key: SecretStr | None = Field(None, alias='LAB_MODEL_KEY')
    second_url: str | None = Field(None, alias='LAB_SECOND_URL')
    second_model: str | None = Field(None, alias='LAB_SECOND_MODEL')
    second_key: SecretStr | None = Field(None, alias='LAB_SECOND_KEY')
    openrouter_key: SecretStr | None = Field(None, alias='OPENROUTER_API_KEY')
    concurrency: int = Field(6, ge=1, alias='LAB_MODEL_CONCURRENCY')

    # The bank's gateway: the archived Agent Lab's settings file, and what the environment says over it.
    gateway_file: Path | None = Field(None, alias='AGENT_LAB_GATEWAY_FILE')
    gateway_url: str | None = Field(None, alias='AGENT_LAB_GATEWAY_URL')
    gateway_cert: str | None = Field(None, alias='AGENT_LAB_GATEWAY_CERT_PATH')
    gateway_key: str | None = Field(None, alias='AGENT_LAB_GATEWAY_KEY_PATH')
    gateway_ca: str | None = Field(None, alias='AGENT_LAB_GATEWAY_CA_PATH')
    gateway_insecure: bool | None = Field(None, alias='AGENT_LAB_GATEWAY_INSECURE')

    @field_validator('data', 'certs', 'frontend', 'gateway_file', mode='before')
    @classmethod
    def _place(cls, value: object) -> object:
        """A folder or file as a person writes it: ~ is their home, a relative path is under the Lab's folder."""
        if isinstance(value, str | Path):
            path = Path(value).expanduser()
            return path if path.is_absolute() else ROOT / path
        return value

    @field_validator('allowed_hosts', mode='before')
    @classmethod
    def _hosts(cls, value: object) -> object:
        """Names separated by commas or spaces, in any case; an address in brackets ([::1]) as the address."""
        if isinstance(value, str):
            value = value.replace(',', ' ').split()
        if isinstance(value, Iterable):
            return frozenset(str(name).strip('[]').lower() for name in value)
        return value

    @field_validator('gateway_insecure', mode='before')
    @classmethod
    def _insecure(cls, value: object) -> object:
        """Only «1» turns the gateway's certificate check off."""
        return value == '1' if isinstance(value, str) else value

    @classmethod
    def from_environment(cls, environ: Mapping[str, str] | None = None) -> 'Settings':
        """The settings of a Lab started in this environment: what it sets, and the Lab's own places for the rest. A
        variable set to nothing is not set."""
        given = {name: value for name, value in (os.environ if environ is None else environ).items() if value.strip()}
        return cls.model_validate({**PLACES, **given})


_CURRENT: ContextVar[Settings] = ContextVar('settings')


def current() -> Settings:
    """The settings of the Lab this request, job or command works in."""
    try:
        return _CURRENT.get()
    except LookupError:
        raise RuntimeError(
            'No Lab settings here: start the Lab with lab.app, or run the code in config.using()'
        ) from None


@contextmanager
def using(settings: Settings) -> Iterator[Settings]:
    """Run inside a Lab with these settings: the app's requests and jobs, a command, a test."""
    token = _CURRENT.set(settings)
    try:
        yield settings
    finally:
        _CURRENT.reset(token)
