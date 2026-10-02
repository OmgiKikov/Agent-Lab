"""How well a deck's synthetic customers stand for the logged ones. Every number keeps its denominator.

- grounding: quoted items kept and dropped by the code's check, filled masked openings, identifiers taken from the
  log against variants chosen for the card;
- population: the representative set against all imported episodes by the export's own features (total variation
  distance), next to the distance random samples of the same size show, so a gap is read against sampling noise and
  not against an invented threshold;
- diversity: how alike the cards' openings are, against random real openings; how alike the text the model wrote is,
  against the customers' own messages; near-duplicate briefs; distinct behaviour signatures;
- knowledge: statuses of the customers' facts, observed reactions and untested hypotheses;
- worlds: how alike the mocked clients are (repeated INN and terminal numbers, terminals per client).
"""

import random
import statistics
from collections import Counter
from collections.abc import Callable
from itertools import combinations
from math import sqrt

from . import cards

DRAWS = 200
NEAR = 0.9  # briefs this alike (character trigrams) count as near-duplicates


def _features() -> dict[str, Callable[[dict], str]]:
    def meta(d: dict) -> dict:
        return d.get('meta') or {}

    def turns(d: dict) -> str:
        count = sum(m['role'] == 'user' for m in d['messages'])
        return str(count) if count < 4 else '4+'

    return {
        'канал': lambda d: meta(d).get('channel') or '—',
        'участники': lambda d: 'только эквайринг' if meta(d).get('agents') == ['ACQUIRING_AGENT'] else 'смешанный',
        'реплик клиента': turns,
        'вызов оператора': lambda d: 'да' if meta(d).get('operator') else 'нет',
        'приветствие в начале': lambda d: 'да' if cards.GREETING.match(d['messages'][0]['content']) else 'нет',
    }


def _shares(values: list[str]) -> dict[str, float]:
    counts = Counter(values)
    return {key: round(count / len(values), 3) for key, count in sorted(counts.items())}


def _tvd(a: dict[str, float], b: dict[str, float]) -> float:
    return round(sum(abs(a.get(k, 0) - b.get(k, 0)) for k in set(a) | set(b)) / 2, 3)


def _grams(text: str) -> Counter:
    text = ' '.join(text.lower().split())
    return Counter(text[i : i + 3] for i in range(max(0, len(text) - 2)))


def _cosine(a: Counter, b: Counter) -> float:
    dot = sum(value * b[key] for key, value in a.items())
    norm = sqrt(sum(v * v for v in a.values())) * sqrt(sum(v * v for v in b.values()))
    return dot / norm if norm else 0.0


def _alike(texts: list[str]) -> float:
    grams = [_grams(text) for text in texts]
    pairs = [_cosine(a, b) for a, b in combinations(grams, 2)]
    return round(statistics.mean(pairs), 3) if pairs else 0.0


def population(sample: list[dict], pool: list[dict]) -> dict:
    rng = random.Random(cards.SEED)
    report = {}
    for name, feature in _features().items():
        everyone = _shares([feature(d) for d in pool])
        chosen = _shares([feature(d) for d in sample])
        noise = sorted(
            _tvd(_shares([feature(d) for d in rng.sample(pool, len(sample))]), everyone) for _ in range(DRAWS)
        )
        report[name] = {
            'set': chosen,
            'export': everyone,
            'distance': _tvd(chosen, everyone),
            'randomSample95': noise[int(0.95 * DRAWS) - 1],
        }
    return report


def diversity(deck: list[dict], pool: list[dict]) -> dict:
    rng = random.Random(cards.SEED)
    sources = {str(d['id']): [m for m in d['messages'] if m['role'] == 'user'] for d in pool}
    openings = [card['opening'] for card in deck]
    real = sorted(_alike([d['messages'][0]['content'] for d in rng.sample(pool, len(deck))]) for _ in range(20))
    briefs = [_grams(card['situation']) for card in deck]
    near = [(a, b) for (a, x), (b, y) in combinations(enumerate(briefs), 2) if _cosine(x, y) >= NEAR]

    def signature(card: dict) -> tuple:
        manner = card['style']
        return (
            min(int(manner['words'] // 5), 4),
            manner['greeting'],
            manner['polite'],
            (manner['capital'] or 0) >= 0.5,
            (manner['endMark'] or 0) >= 0.5,
            tuple(sorted({r['trigger'] for r in card['reactions']})),
        )

    return {
        'openingsAlike': _alike(openings),
        'realOpeningsAlike': {'min': real[0], 'median': real[len(real) // 2], 'max': real[-1]},
        # What the model wrote against what the customers wrote: a ratio well above 1 is the model's own voice.
        'writtenAlike': _alike(
            [' '.join([c['goal']] + [x['text'] for x in c['circumstances'] + c['facts']]) for c in deck]
        ),
        'sourceAlike': _alike([' '.join(m['content'] for m in sources[c['sourceDialogueId']]) for c in deck]),
        'hypothesesAlike': _alike([' '.join(x['response'] for x in c['hypotheses']) for c in deck if c['hypotheses']]),
        'reactionsAlike': _alike([' '.join(x['response'] for x in c['reactions']) for c in deck if c['reactions']]),
        'nearDuplicateBriefs': [[deck[a]['id'], deck[b]['id']] for a, b in near],
        'signatures': len({signature(card) for card in deck}),
        'cards': len(deck),
    }


def grounding(deck: list[dict]) -> dict:
    dropped = Counter()
    kept = Counter()
    for card in deck:
        dropped.update(card['checks']['dropped'])
        for field in ('circumstances', 'facts', 'observations', 'reactions'):
            kept[field] += len(card[field])
    masked = [card for card in deck if cards.MASK.search(card['opening'])]
    basis = Counter(f'{name}:{value["basis"]}' for card in deck for name, value in card['identifiers'].items())
    # A world that misses the terminal or INN the customer's first message names makes the agent's first lookup fail.
    unmatched = sum(card['checks'].get('worldUsesOpeningIds') is False for card in deck)
    return {
        'kept': dict(kept),
        'dropped': dict(dropped),
        'unfilledOpenings': len(masked),
        'worldMissesOpeningIds': unmatched,
        'identifiers': dict(basis),
    }


def knowledge(deck: list[dict]) -> dict:
    return {
        'facts': dict(Counter(fact.get('status') for card in deck for fact in card['facts'])),
        'notEstablished': sum(len(card['notEstablished']) for card in deck),
        'observations': sum(len(card['observations']) for card in deck),
        'reactions': dict(Counter(r['trigger'] for card in deck for r in card['reactions'])),
        'hypotheses': sum(len(card['hypotheses']) for card in deck),
    }


def worlds(deck: list[dict]) -> dict | None:
    """How alike the mocked clients are: the most repeated INN and terminal number, and terminals per client."""
    built = [card['world'] for card in deck if card.get('world')]
    if not built:
        return None
    inns = Counter(w['organization']['inn'] for w in built)
    terminals = Counter(t['terminalId'] for w in built for t in w['terminals'])
    return {
        'worlds': len(built),
        'distinctInn': len(inns),
        'topInnShare': round(inns.most_common(1)[0][1] / len(built), 3),
        'topTerminalShare': round(terminals.most_common(1)[0][1] / len(built), 3),
        'terminalsPerClient': dict(sorted(Counter(len(w['terminals']) for w in built).items())),
    }


def report(value: dict, pool: list[dict]) -> dict:
    """The report on a deck (cards.run) against the imported conversations it was drawn from."""
    deck = [card for card in value.get('cards') or [] if card.get('checks')]
    by_id = {str(d['id']): d for d in pool}
    sets = value.get('sets') or {}
    represented = [
        by_id[c['sourceDialogueId']] for c in deck if 'representative' in c['sets'] and c['sourceDialogueId'] in by_id
    ]
    return {
        'sets': {
            key: {k: v for k, v in manifest.items() if k != 'cardIds'} | {'cards': len(manifest.get('cardIds') or [])}
            for key, manifest in sets.items()
        },
        'grounding': grounding(deck),
        'knowledge': knowledge(deck),
        'worlds': worlds(deck),
        'population': population(represented, pool) if represented and pool else None,
        'diversity': diversity(deck, pool) if len(deck) > 1 and len(pool) >= len(deck) else None,
    }
