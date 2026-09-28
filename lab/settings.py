"""Where the Lab keeps its files and finds its neighbours. Each value can be overridden by the environment.
What a person sets on the page (the agent's address, customers, repository) is in agents.settings()."""

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
# Logs, sources, cards, runs and page settings: real bank data, git-ignored, never in the repository.
DATA = Path(os.environ.get('LAB_DATA', ROOT / 'data'))
# Certificates of the bank's model gateway, dropped in by hand on the work computer.
CERTS = ROOT / 'certs'

MOCK_URL = os.environ.get('AGENT_LAB_MOCK_URL', 'http://127.0.0.1:8090')
AGENT_TIMEOUT = float(os.environ.get('LAB_AGENT_TIMEOUT', '180'))
WORKSHOP_URL = os.environ.get('LAB_WORKSHOP_URL', 'http://127.0.0.1:5899').rstrip('/')
