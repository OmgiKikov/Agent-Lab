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
import random

from .. import llm
from ..prompts import WORLD
from . import repo

FIXTURES = 'local/mocks/fixtures/sbe.json'  # in the agent's repository
SCENARIO_TOOLS = (
    'getLkkTariff',
    'terminalInfoByTidV2',
    'acquiringSettlements',
    'getLkkTransactionList',
    'getServicesListInfoByUcpid',
    'MakeReqToSM2',
)
MAX_BODY = 19000  # the mock server rejects override bodies over 20000 characters

# Element shapes for lists that are empty in the fixtures (from the agent's pydantic models).
SETTLEMENT_ITEMS = {
    'credits': {
        'amount': 1500.0,
        'contractId': '',
        'accountNumberCredit': '',
        'creationReason': '',
        'terminalIds': [''],
    },
    'refund': {'terminalId': '', 'requestAmount': 1500.0, 'authorizationDateTime': '01.09.2026 12:00'},
}


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


def conforms(value: object, shape: object) -> bool:
    """Same keys and value types as the template; lists may change length."""
    if isinstance(shape, dict):
        return isinstance(value, dict) and set(value) == set(shape) and all(conforms(value[k], shape[k]) for k in shape)
    if isinstance(shape, list):
        if not isinstance(value, list):
            return False
        return not value if not shape else all(conforms(v, shape[0]) for v in value)
    if isinstance(shape, bool):
        return isinstance(value, bool)
    if isinstance(shape, (int, float)):
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    if shape is None:
        return value is None or isinstance(value, (str, int, float, bool))
    return isinstance(value, str)


def _digits(value: object, n: int) -> str:
    text = ''.join(ch for ch in str(value) if ch.isdigit())
    return text[:n] if len(text) >= n else ''.join(random.choice('123456789') for _ in range(n))


def normalize(raw: dict, shapes: dict) -> dict:
    org = raw.get('organization') or {}
    organization = {
        'name': str(org.get('name') or 'ООО «Тестовая точка»')[:80],
        'inn': _digits(org.get('inn'), 10),
        'merchantName': str(org.get('merchantName') or org.get('name') or 'Точка')[:60],
        'address': str(org.get('address') or 'г. Москва, ул. Тверская, д. 1')[:120],
    }
    terminals = []
    for index, item in enumerate((raw.get('terminals') or [])[:3], 1):
        if isinstance(item, dict):
            terminals.append(
                {
                    'nameForClient': str(item.get('nameForClient') or f'Касса №{index}')[:40],
                    'terminalId': _digits(item.get('terminalId'), 8),
                    'stateCode': 'BLOCKED' if item.get('stateCode') == 'BLOCKED' else 'ACTIVE',
                }
            )
    if not terminals:
        terminals = [{'nameForClient': 'Касса №1', 'terminalId': _digits('', 8), 'stateCode': 'ACTIVE'}]
    tools = {
        name: value
        for name, value in (raw.get('tools') or {}).items()
        if name in SCENARIO_TOOLS and name in shapes and conforms(value, shapes[name])
    }
    return {
        'organization': organization,
        'terminals': terminals,
        'tools': tools,
        'dropped': sorted(set(raw.get('tools') or {}) - set(tools)),
    }


async def build(situation: str, customer: list[str]) -> dict | None:
    shapes = templates()
    if shapes is None:
        return None

    def parse(value: dict) -> dict:
        if not isinstance(value.get('organization'), dict) or not isinstance(value.get('terminals'), list):
            raise ValueError('world needs an organization and terminal list')
        return value

    answer = await llm.structured(
        WORLD,
        {
            'situation': situation,
            'customerMessages': customer,
            'templates': {name: shapes[name] for name in SCENARIO_TOOLS if name in shapes},
        },
        parse=parse,
    )
    return normalize(answer.value, shapes)


def overrides(world: dict | None) -> dict:
    """Full per-request SBE answers: identity tools from the world's client + the scenario's own data."""
    shapes = templates()
    if not world or shapes is None:
        return {}
    org, terminals = world['organization'], world['terminals']
    merchant_id = '9' + org['inn'][:8]
    contract = {'product': 'Торговый эквайринг', 'stateCode': 'ACTIVE', 'creationDate': '2024-03-11'}
    terminal_list = [{'tid': t['terminalId'], 'stateCode': t['stateCode']} for t in terminals]
    identity = {
        'organizationInfoByEpkId': {
            'organizations': [{'inn': org['inn'], 'contracts': [contract], 'terminalList': terminal_list}]
        },
        'organizationContractsInfoByEpkId': {
            'organizations': [{'inn': org['inn'], 'contracts': [contract], 'terminalList': terminal_list}]
        },
        'organizationInfoByMidOrTid': {
            'organization': {
                'inn': org['inn'],
                'kpp': org['inn'][:4] + '01001',
                'clientModuleId': '1000000001',
                'name': org['name'],
            }
        },
        'getLkkTerminalList': {
            'pagination': {'size': 10, 'page': 0, 'hasNext': False},
            'terminals': [
                {
                    'address': org['address'],
                    'nameForClient': t['nameForClient'],
                    'merchantId': merchant_id,
                    'terminalId': t['terminalId'],
                    'merchantName': org['merchantName'],
                }
                for t in terminals
            ],
        },
    }
    tools = {
        name: {'responseType': 'JSON', 'text': value}
        for name, value in {**identity, **world['tools']}.items()
        if name in shapes and conforms(value, shapes[name])
    }
    # Keep within the mock server's size limit: scenario tools are dropped last-first if needed.
    for name in reversed(list(world['tools'])):
        if len(json.dumps({'trace_id': 'x' * 36, 'sbe': {'tools': tools}}, ensure_ascii=False)) <= MAX_BODY:
            break
        tools.pop(name, None)
    return tools


def customer_profile(world: dict | None) -> str:
    if not world:
        return ''
    org = world['organization']
    terminals = ', '.join(f'{t["nameForClient"]} (номер {t["terminalId"]})' for t in world['terminals'])
    return (
        f'Твоя организация: {org["name"]}, ИНН {org["inn"]}. Торговая точка «{org["merchantName"]}», '
        f'{org["address"]}. Терминалы: {terminals}.'
    )
