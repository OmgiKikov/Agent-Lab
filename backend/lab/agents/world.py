"""The stand's fixtures in the agent's repository: the shapes of what the bank's mocked systems answer, which the world
of a scenario keeps (domain/world.py) so the agent's parsers accept it. The world is sent to the mocks per request
(POST /mock/overrides, keyed by x-trace-id)."""

import copy
import json
from pathlib import Path

from ..domain.world import SETTLEMENT_ITEMS

FIXTURES = 'local/mocks/fixtures/sbe.json'  # in the agent's repository


def templates(repo: Path) -> dict | None:
    """The stand's fixture responses in the agent's repository, or None where the stand is not installed (e.g. the
    work computer)."""
    try:
        tools = json.loads((repo / FIXTURES).read_text(encoding='utf-8'))['tools']
    except (OSError, ValueError, KeyError):
        return None
    shapes = {
        name: copy.deepcopy(entry['text']) for name, entry in tools.items() if isinstance(entry.get('text'), dict)
    }
    if 'acquiringSettlements' in shapes:
        shapes['acquiringSettlements'].update({k: [v] for k, v in SETTLEMENT_ITEMS.items()})
    return shapes
