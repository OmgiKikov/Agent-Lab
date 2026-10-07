"""The profile of the agent under test: what its customers come to it with (its domain, what belongs to it and what does
not, with examples of tasks and categories), which identifiers a customer of it may give, and how the export names the
agent. The episode reader, the catalog and the card read the domain from here, so the same pipeline serves any support
agent: no prompt and no code of the pipeline names one. Pure functions; flows/profile.py keeps the profile.
"""

import hashlib
import json
import re
import statistics
from collections.abc import Callable, Sequence

KEY = re.compile(r'[a-z][a-z0-9_]*')
LONG = 0.9  # a conversation is long from this quantile of customer messages in the export on
LONGEST = 2  # ...but never from fewer customer messages than this


def checked(value: object) -> dict:
    """The profile, if the pipeline can use it: a domain, identifiers each with a key and a label, lists of words where
    lists are asked for. A ValueError says what is wrong."""
    if not isinstance(value, dict):
        raise ValueError('Профиль агента — объект.')
    domain = str(value.get('domain') or '').strip()
    if not domain:
        raise ValueError('В профиле агента нет домена: чем агент занимается.')

    def words(name: str) -> list[str]:
        found = value.get(name) or []
        if not isinstance(found, list) or not all(isinstance(x, str) and x.strip() for x in found):
            raise ValueError(f'«{name}» в профиле агента — список строк.')
        return [x.strip() for x in found]

    identifiers = value.get('identifiers') or []
    if not isinstance(identifiers, list) or not all(
        isinstance(x, dict) and KEY.fullmatch(str(x.get('key') or '')) and str(x.get('label') or '').strip()
        for x in identifiers
    ):
        raise ValueError('Идентификаторы в профиле агента — список {key, label}, key латиницей.')
    categories = value.get('categoryExamples') or {}
    if not isinstance(categories, dict):
        raise ValueError('«categoryExamples» в профиле агента — категории со списками сценариев.')
    export = value.get('export') or {}
    if not isinstance(export, dict):
        raise ValueError('«export» в профиле агента — объект.')
    return {
        'name': str(value.get('name') or '').strip(),
        'domain': domain,
        'includes': words('includes'),
        'excludes': words('excludes'),
        'taskExamples': words('taskExamples'),
        'objectExamples': words('objectExamples'),
        'categoryExamples': {str(k): [str(s) for s in v or []] for k, v in categories.items()},
        'identifiers': [{'key': x['key'], 'label': x['label'].strip()} for x in identifiers],
        'export': {
            'agentCode': export.get('agentCode') or None,
            'sharedAgents': [str(x) for x in export.get('sharedAgents') or []],
            'statusMarker': export.get('statusMarker') or None,
            'stressStatuses': [str(x) for x in export.get('stressStatuses') or []],
            'longTurns': export.get('longTurns') if isinstance(export.get('longTurns'), int) else None,
        },
    }


def for_models(profile: dict) -> dict:
    """What the models are told about the agent: its domain with its examples and the identifiers of its customers."""
    return {key: profile[key] for key in ('name', 'domain', 'includes', 'excludes', 'identifiers')} | {
        'examples': {
            'tasks': profile['taskExamples'],
            'objects': profile['objectExamples'],
            'categories': profile['categoryExamples'],
        }
    }


def revision(profile: dict) -> str:
    """Names what the models were told: a reading made under another revision is read again."""
    return hashlib.sha256(json.dumps(for_models(profile), ensure_ascii=False, sort_keys=True).encode()).hexdigest()[:12]


def keys(profile: dict) -> list[str]:
    return [x['key'] for x in profile['identifiers']]


def label(profile: dict, key: str) -> str:
    return next((x['label'] for x in profile['identifiers'] if x['key'] == key), key)


def statuses(meta: dict, marker: str | None) -> set[str]:
    """The status codes the export gives the agent with this marker in one conversation. An export read before statuses
    were kept by agent has only the codes of the agent it was made for (acquiringStatuses)."""
    if 'statuses' not in meta:
        return set(meta.get('acquiringStatuses') or [])
    return {
        code for code, agents in (meta.get('statuses') or {}).items() if marker and any(marker in a for a in agents)
    }


def long_turns(profile: dict, dialogues: Sequence[dict]) -> int:
    """From how many customer messages a conversation of this export is long: the profile's number, else the LONG
    quantile of the export, at least LONGEST."""
    if profile['export']['longTurns']:
        return profile['export']['longTurns']
    counts = [sum(m['role'] == 'user' for m in d.get('messages') or []) for d in dialogues]
    if len(counts) < 2:
        return max(LONGEST, max(counts, default=LONGEST))
    return max(LONGEST, round(statistics.quantiles(counts, n=10)[int(LONG * 10) - 1]))


def rare(profile: dict, dialogues: Sequence[dict]) -> dict[str, Callable[[dict], bool]]:
    """The conditions of the stress set, named as a person reads them: a long conversation for this export, a failure
    status the export gives this agent, other agents in the chat besides this one and the shared assistants."""
    export, found = profile['export'], {}
    turns = long_turns(profile, dialogues)
    found[f'{turns} и больше реплик клиента'] = (
        lambda d: sum(m['role'] == 'user' for m in d.get('messages') or []) >= turns
    )
    codes = set(export['stressStatuses'])
    if codes:
        found[f'Агент вернул {" или ".join(sorted(c.replace("_", "-") for c in codes))}'] = lambda d: bool(
            codes & statuses(d.get('meta') or {}, export['statusMarker'])
        )
    if export['agentCode']:
        own = {export['agentCode'], *export['sharedAgents']}
        found['В чате были другие агенты, кроме общего ассистента'] = lambda d: bool(
            set((d.get('meta') or {}).get('agents') or []) - own
        )
    return found
