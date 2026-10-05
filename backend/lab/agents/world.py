"""Scenario world: what the bank's business systems (SBE mocks of the local agent) answer in this scenario.

The stand's default fixtures describe one client for every test. A card gets its own world instead:
the client from the logged situation (organization, point of sale, terminals) and the data its
question depends on (tariff, terminal state, operations, settlements, service requests).
Responses keep the exact shape of the stand's fixtures, so the agent's parsers accept them; any
generated tool whose shape differs is dropped and the stand's default answer is used.
The world is sent to the mocks per request (POST /mock/overrides, keyed by x-trace-id).
"""

import copy
import json

from ..domain.world import SETTLEMENT_ITEMS
from . import repo

FIXTURES = 'local/mocks/fixtures/sbe.json'  # in the agent's repository


def templates() -> dict | None:
    """The stand's fixture responses, or None where the stand is not installed (e.g. the work computer)."""
    try:
        tools = json.loads((repo() / FIXTURES).read_text(encoding='utf-8'))['tools']
    except (OSError, ValueError, KeyError):
        return None
    shapes = {
        name: copy.deepcopy(entry['text']) for name, entry in tools.items() if isinstance(entry.get('text'), dict)
    }
    if 'acquiringSettlements' in shapes:
        shapes['acquiringSettlements'].update({k: [v] for k, v in SETTLEMENT_ITEMS.items()})
    return shapes
