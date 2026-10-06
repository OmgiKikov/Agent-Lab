"""Where the Lab keeps its files and finds its neighbours. Each value can be overridden by the environment.
What a person sets on the page (the agent's address, customers, repository) is in agents.settings()."""

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def _path(name: str, default: Path) -> Path:
    value = Path(os.environ.get(name, default)).expanduser()
    return value if value.is_absolute() else ROOT / value


# Logs, sources, cards, runs and page settings: real bank data, git-ignored, never in the repository.
DATA = _path('LAB_DATA', ROOT / 'data')
# Certificates of the bank's model gateway, dropped in by hand on the work computer.
CERTS = _path('LAB_CERTS', ROOT / 'certs')

MOCK_URL = os.environ.get('AGENT_LAB_MOCK_URL', 'http://127.0.0.1:8090')
AGENT_TIMEOUT = float(os.environ.get('LAB_AGENT_TIMEOUT', '180'))
FRONTEND = _path('LAB_FRONTEND', ROOT / 'frontend/dist')


def replay_url() -> str:
    """The replay service on the stand (aigw-local replay/), its origin: http://host:port. Read at every call, so a
    changed address is picked up without a restart."""
    return os.environ.get('LAB_REPLAY_URL', '').strip()
