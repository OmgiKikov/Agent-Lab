"""The world of a scenario: what the mocked business systems behind the agent answer in it (the stand's SBE mocks).

The stand's default fixtures describe one client for every test. A scenario gets its own world instead: the client from
the logged situation (organization, point of sale, terminals) and the data its question depends on (tariff, terminal
state, operations, settlements, service requests). Answers keep the exact shape of the stand's fixtures (shapes), so the
agent's parsers accept them; a tool whose shape differs is dropped and the stand's default answer is used.
"""

import json
import random

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


def identity(seed: str) -> dict:
    """The client's numbers, chosen here so worlds differ: the model copies the templates' client otherwise.
    How many terminals customers have is not calibrated yet: one, two or three, the same for the same seed."""
    rng = random.Random(f'world:{seed}')
    count = rng.choices((1, 2, 3), weights=(5, 3, 2))[0]
    return {
        'inn': str(rng.randint(1, 9)) + ''.join(str(rng.randint(0, 9)) for _ in range(9)),
        'terminalIds': [str(rng.randint(10_000_000, 99_999_999)) for _ in range(count)],
    }


def overrides(world: dict | None, shapes: dict | None) -> dict:
    """Full per-request SBE answers: identity tools from the world's client + the scenario's own data."""
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


def customer_profile(world: dict | None, known: dict | None = None) -> str:
    """The client's view of the world: the organization and its terminals as far as this customer knows them.
    known (the card's identifiers): per identifier knows | looks_up | unknown; without it the customer knows all."""
    if not world:
        return ''
    org = world['organization']

    def what(name: str) -> str:
        return ((known or {}).get(name) or {}).get('value', 'knows')

    inn = {
        'knows': f', ИНН {org["inn"]}',
        'looks_up': f', ИНН наизусть не помнишь; если попросят, посмотришь: {org["inn"]}',
        'unknown': ', ИНН не знаешь',
    }[what('organization')]
    numbers = what('terminal')
    terminals = ', '.join(
        t['nameForClient'] + (f' (номер {t["terminalId"]})' if numbers != 'unknown' else '') for t in world['terminals']
    )
    note = {
        'knows': '',
        'looks_up': ' Номера терминалов наизусть не помнишь: если попросят, сначала скажи, что посмотришь.',
        'unknown': ' Номеров терминалов не знаешь.',
    }[numbers]
    return (
        f'Твоя организация: {org["name"]}{inn}. Торговая точка «{org["merchantName"]}», '
        f'{org["address"]}. Терминалы: {terminals}.{note}'
    )
