"""The catalog of business scenarios: what customers come to the acquiring agent with, and how often. Pure functions;
the models' part is roles/catalog.py, the process flows/catalog.py.

Every conversation of the export is read once (an episode: does the customer have an acquiring task, where it starts,
the task and its object). The tasks of all episodes are grouped into categories (a business area: QR payments,
terminals, tariffs) and, inside each, scenarios (one task as the customer names it: «Не работает QR», «Подключить
QR»), each with a description; then every episode is placed in one scenario, and the code counts them. The catalog
is frozen with its revision: a new export is placed into the same scenarios, and a rebuild makes a new revision.

The catalog is another axis than the topics of a check: a topic says by which criteria a conversation is judged (from
the agent's code), a scenario what the customer wanted (from the conversations). A card names both.
"""

import hashlib
import json
import random
from collections import Counter
from collections.abc import Collection

NONE = 'none'  # an acquiring episode the router placed in no scenario of the catalog
NONE_TITLE = 'Не попал в каталог'
SEED = 20261005  # the same sample and the same examples for the same catalog
EXAMPLES = 3
RARE = 3  # a scenario with fewer episodes is marked rare: its share is not an estimate
EVENT_CHARS = 1000  # a message as the episode reader sees it: long instructions are cut, the start stays


def fingerprint(dialogue: dict) -> str:
    """What an episode's reading stands on: the conversation's messages."""
    return hashlib.sha256(json.dumps(dialogue['messages'], ensure_ascii=False).encode()).hexdigest()[:12]


def events(dialogue: dict) -> list[dict]:
    """The chat as the episode reader sees it: numbered messages of the customer and the agent, each cut to
    EVENT_CHARS."""
    return [
        {'n': n, 'role': 'CUSTOMER' if m['role'] == 'user' else 'AGENT', 'text': m['content'][:EVENT_CHARS]}
        for n, m in enumerate(dialogue['messages'], 1)
    ]


def checked_episode(value: dict, dialogue: dict) -> dict:
    """The reader's answer, if it can be used: an acquiring episode starts at a customer's message, ends at a later
    message (where the customer turns to another task, or the chat's last one) and names a task. An answer that leaves
    acquiring out is read by its task. A ValueError asks the model again."""
    if value.get('acquiring') is None and not str(value.get('task') or '').strip():
        raise ValueError('episode needs acquiring')
    if value.get('acquiring') is False:
        return {'acquiring': False, 'reason': str(value.get('reason') or '').strip()}
    messages, start = dialogue['messages'], value.get('start')
    if not isinstance(start, int) or not 1 <= start <= len(messages) or messages[start - 1]['role'] != 'user':
        raise ValueError('episode start must be a customer message')
    end = value.get('end')
    if not isinstance(end, int) or not start <= end <= len(messages):
        raise ValueError('episode end must be a message from its start on')
    task, thing = str(value.get('task') or '').strip(), str(value.get('object') or '').strip()
    if not task:
        raise ValueError('episode needs a task')
    return {'acquiring': True, 'start': start, 'end': end, 'task': task.rstrip('.'), 'object': thing.rstrip('.')}


def sample(episodes: dict[str, dict], size: int) -> dict[str, dict]:
    """At most size acquiring episodes, a random sample the same for the same export: the catalog is proposed from
    it."""
    acquiring = sorted(i for i, e in episodes.items() if e.get('acquiring'))
    chosen = random.Random(SEED).sample(acquiring, min(size, len(acquiring)))
    return {i: episodes[i] for i in sorted(chosen)}


def distinct_tasks(episodes: dict[str, dict]) -> list[dict]:
    """Each task of the acquiring episodes once, with its object and how many episodes have it, the most frequent
    first: what the catalog role reads."""
    counted: dict[tuple[str, str], int] = {}
    for episode in episodes.values():
        if episode.get('acquiring'):
            key = (episode['task'].lower(), episode['object'].lower())
            counted[key] = counted.get(key, 0) + 1
    ordered = sorted(counted.items(), key=lambda item: (-item[1], item[0]))
    return [{'task': task, 'object': thing, 'count': count} for (task, thing), count in ordered]


def opening(dialogue: dict, episode: dict) -> str:
    """The customer's first message of the episode, as the log has it."""
    return dialogue['messages'][episode['start'] - 1]['content']


def taxonomy(categories: list[dict]) -> list[dict]:
    """The proposed categories with ids (c1, c1s2…): blank titles and repeated scenario titles are dropped, so are
    categories left without a scenario."""
    found, seen = [], set()
    for category in categories:
        title = str(category.get('title') or '').strip()
        scenarios = []
        for scenario in category.get('scenarios') or []:
            name = str(scenario.get('title') or '').strip()
            if not name or name.lower() in seen:
                continue
            seen.add(name.lower())
            scenarios.append({'title': name, 'description': str(scenario.get('description') or '').strip()})
        if title and scenarios:
            index = len(found) + 1
            found.append(
                {
                    'id': f'c{index}',
                    'title': title,
                    'description': str(category.get('description') or '').strip(),
                    'scenarios': [dict(s, id=f'c{index}s{n}') for n, s in enumerate(scenarios, 1)],
                }
            )
    if not found:
        raise ValueError('catalog needs a category with a scenario')
    return found


def bare(categories: list[dict]) -> list[dict]:
    """The scenarios of a saved catalog without their counts and examples: what the router places episodes in."""
    return [
        {
            'id': c['id'],
            'title': c['title'],
            'description': c['description'],
            'scenarios': [
                {'id': s['id'], 'title': s['title'], 'description': s['description']} for s in c['scenarios']
            ],
        }
        for c in categories
    ]


def revision(categories: list[dict]) -> str:
    """Names the catalog's scenarios as they were proposed: a rebuilt catalog is another revision."""
    shape = [
        [c['id'], c['title'], c['description'], [[s['id'], s['title'], s['description']] for s in c['scenarios']]]
        for c in categories
    ]
    return hashlib.sha256(json.dumps(shape, ensure_ascii=False).encode()).hexdigest()[:12]


def scenarios_of(categories: list[dict]) -> dict[str, dict]:
    """Every scenario by its id, with its category's id and title: what a card names. An acquiring episode the router
    placed in none is named so too: its card is still a customer of the export."""
    found = {
        s['id']: {'id': s['id'], 'title': s['title'], 'categoryId': c['id'], 'category': c['title']}
        for c in categories
        for s in c['scenarios']
    }
    return found | {NONE: {'id': NONE, 'title': NONE_TITLE, 'categoryId': NONE, 'category': NONE_TITLE}}


def counted(categories: list[dict], episodes: dict[str, dict], dialogues: dict[str, dict]) -> dict:
    """The catalog as a person reads it: each category and scenario with its number of episodes, its share of the
    placed acquiring episodes and up to EXAMPLES real first messages; the totals of the export."""
    placed = Counter(e['scenarioId'] for e in episodes.values() if e.get('acquiring') and e.get('scenarioId'))
    total = sum(placed.values())
    members: dict[str, list[str]] = {}
    for dialogue_id, episode in sorted(episodes.items()):
        if episode.get('acquiring') and episode.get('scenarioId'):
            members.setdefault(episode['scenarioId'], []).append(dialogue_id)

    def examples(scenario_id: str) -> list[dict]:
        ids = members.get(scenario_id, [])
        chosen = random.Random(f'{SEED}:{scenario_id}').sample(ids, min(EXAMPLES, len(ids)))
        return [
            {'dialogueId': i, 'task': episodes[i]['task'], 'opening': opening(dialogues[i], episodes[i])[:300]}
            for i in chosen
            if i in dialogues
        ]

    def share(count: int) -> float | None:
        return round(count / total, 4) if total else None

    shown = []
    for category in categories:
        scenarios = [
            dict(s, count=placed[s['id']], share=share(placed[s['id']]), rare=placed[s['id']] < RARE)
            | {'examples': examples(s['id'])}
            for s in category['scenarios']
        ]
        count = sum(s['count'] for s in scenarios)
        shown.append(dict(category, scenarios=scenarios, count=count, share=share(count)))
    readings = Counter(
        'error' if e.get('error') else 'acquiring' if e.get('acquiring') else 'other' for e in episodes.values()
    )
    totals = {
        'dialogues': len(episodes),
        'acquiring': readings['acquiring'],
        'notAcquiring': readings['other'],
        'unread': readings['error'],
        'placed': total - placed[NONE],
        'unplaced': placed[NONE],
        'notYetPlaced': sum(1 for e in episodes.values() if e.get('acquiring') and not e.get('scenarioId')),
    }
    return {'categories': shown, 'totals': totals}


def strata(episodes: dict[str, dict]) -> dict[str, list[str]]:
    """The placed acquiring episodes by scenario (the unplaced ones are a stratum of their own), each sorted by id."""
    found: dict[str, list[str]] = {}
    for dialogue_id, episode in episodes.items():
        if episode.get('acquiring') and episode.get('scenarioId'):
            found.setdefault(episode['scenarioId'], []).append(dialogue_id)
    return {key: sorted(ids) for key, ids in sorted(found.items())}


def allocate(groups: dict[str, list[str]], size: int) -> tuple[list[tuple[str, str, float]], dict]:
    """A stratified sample: each scenario gets its share of size by its number of episodes (largest remainders), and
    at least one card, so every scenario of the catalog has a customer. Each chosen episode stands for N_h / n_h
    episodes of its scenario: weighted, the sample estimates the whole export; unweighted, rare scenarios count as
    much as frequent ones. (episode, scenario, weight) and the sample's manifest."""
    population = sum(len(ids) for ids in groups.values())
    if not population:
        return [], {'method': 'стратифицированная выборка по сценариям', 'population': 0, 'sample': 0}
    exact = {key: size * len(ids) / population for key, ids in groups.items()}
    counts = {key: int(value) for key, value in exact.items()}
    for key in sorted(exact, key=lambda k: (counts[k] - exact[k], k))[: max(0, size - sum(counts.values()))]:
        counts[key] += 1
    chosen = []
    for key, ids in groups.items():
        n = min(len(ids), max(1, counts[key]))
        weight = round(len(ids) / n, 3)
        picked = random.Random(f'{SEED}:{key}').sample(ids, n)
        chosen.extend((dialogue_id, key, weight) for dialogue_id in sorted(picked))
    manifest = {
        'method': 'стратифицированная выборка по сценариям, не меньше одной карточки на сценарий',
        'population': population,
        'sample': len(chosen),
        'strata': len(groups),
        'seed': SEED,
    }
    return chosen, manifest


def replacements(
    groups: dict[str, list[str]], sampled: dict[str, str], lost: Collection[str], taken: Collection[str]
) -> list[tuple[str, str]]:
    """For each sampled episode left without a card (lost: the model failed it, or it was excluded), another episode of
    its scenario, drawn at random from those not taken by any set: the scenario keeps its number of cards. (episode,
    scenario); fewer when a scenario has no episode left."""
    found = []
    for key in sorted({sampled[i] for i in lost}):
        need = sum(1 for i in lost if sampled[i] == key)
        rest = [i for i in groups.get(key, []) if i not in taken]
        chosen = random.Random(f'{SEED}:{key}:reserve').sample(rest, min(need, len(rest)))
        found.extend((dialogue_id, key) for dialogue_id in sorted(chosen))
    return found


def weighted(groups: dict[str, list[str]], carded: dict[str, str]) -> tuple[dict[str, float], dict]:
    """The weight of each card of the representative set (carded: the episodes that got a card, by scenario): N_h / n_h,
    n_h the cards its scenario actually has. A scenario left without a card makes the sample incomplete, and then no
    card gets a weight: the others would stand for the whole export without it. (weights, what the manifest tells)."""
    counts = Counter(carded.values())
    missing = [{'scenarioId': key, 'population': len(ids)} for key, ids in groups.items() if not counts[key]]
    population = sum(len(ids) for ids in groups.values())
    covered = population - sum(item['population'] for item in missing)
    told = {
        'complete': not missing,
        'missing': missing,
        'coverage': round(covered / population, 4) if population else None,
    }
    if missing:
        return {}, told
    return {dialogue_id: round(len(groups[key]) / counts[key], 3) for dialogue_id, key in carded.items()}, told
