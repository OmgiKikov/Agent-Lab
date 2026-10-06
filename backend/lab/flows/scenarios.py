"""Scenarios: the deck of one check, the customers of real conversations in three sets (domain.scenarios), and each
scenario as a test, with its result in every run of the deck's check.

The catalog of business scenarios is brought up to date first (flows/catalog.py): the representative set is sampled by
its scenarios, and every card names the scenario of its episode. A card's criteria are those of its conversation's
topic in the check; a conversation the check did not sample is sorted into its topics by the router.
A card the model fails to build is reported in the progress and never cancels the others; only a deck with no card is
an error. The deck names the check it was built from: a run is measured by that check's criteria.
"""

import asyncio
from collections.abc import Sequence

from .. import models, storage
from ..agents import world
from ..domain import cards, checks, scenarios
from ..domain import catalog as business
from ..roles import card as card_role
from ..roles import world as world_role
from . import Progress, accuracy, catalog, connection, inputs, tone

DECK = checks.DECK  # {check, createdAt, model, cards, sets, catalogRevision}
# What the task says while it builds; the count of the built and the failed ones is the task's own (done of total).
BUILDING = 'Собираем сценарии'
TOPIC_BATCH = 25  # conversations sorted into topics per request: one request for 60 already fails


def deck() -> list[dict]:
    return (storage.documents.load(DECK) or {}).get('cards') or []


def check() -> str | None:
    """The check whose errors the deck was built from."""
    return (storage.documents.load(DECK) or {}).get('check')


def remember_openings(openings: dict[str, dict[str, str]]) -> None:
    """Keep the openings rewritten for customer types (simulation.prepare_openings) in the cards."""

    with storage.transaction():
        value = storage.documents.load(DECK) or {}
        for card in value.get('cards') or []:
            card.setdefault('openings', {}).update(openings.get(card['id'], {}))
        storage.documents.save(DECK, value)


def chosen_check(asked: str | None) -> str | None:
    """The check to build scenarios from: the one asked for, else the only check with a result (None without one). A
    ValueError when both have one and none was asked for."""
    if asked is not None:
        return asked
    found = [key for key in checks.RESULTS if storage.documents.load(checks.result(key))]
    if len(found) > 1:
        raise ValueError('Выберите, из какой проверки собрать сценарии.')
    return next(iter(found), None)


async def build(check: str | None, progress: Progress) -> list[dict]:
    """«Собрать сценарии»: the deck of the check, saved with the check it names and the catalog's revision."""
    if check is None:
        raise RuntimeError('Сценарии собираются по критериям проверки. Сначала проверьте разговоры.')
    deck = await built(check, progress)
    document = {
        'check': check,
        'createdAt': storage.now(),
        'model': models.models_used(deck['cards']),
        **deck,
    }
    storage.documents.save(DECK, document)
    return deck['cards']


async def build_card(
    topic: dict,
    dialogue: dict,
    sets: Sequence[str],
    general: Sequence[dict] = (),
    reproduces: Sequence[str] = (),
    scenario: dict | None = None,
    start: int | None = None,
) -> dict:
    """The card of one conversation: its customer from the whole chat, every item found in the log (roles.card,
    domain.cards), its frozen criteria, and the world of its test data when the stand's fixtures are there
    (roles.world); without them, or when the model gives no usable world, the scenario is played against the stand's
    default answers. A conversation without an acquiring task gives {eligible: false, reason}. start: where the
    catalog's reading put the episode (the card describes the episode its scenario was given for)."""
    answer = await card_role.card(topic['title'], dialogue, start)
    if answer.value.get('eligible') is False:
        return {
            'eligible': False,
            'sets': list(sets),
            'sourceDialogueId': str(dialogue['id']),
            'reason': str(answer.value.get('ineligibleReason') or ''),
        }
    customer = cards.customer(answer.value, dialogue, start)
    raw, written = cards.episode_texts(customer, dialogue)
    prompts = '\n'.join(source['content'] for source in inputs.sources())
    criteria = scenarios.criteria(topic, general, prompts)
    test_data, shapes = None, world.templates(connection.repo())
    if shapes is not None:
        try:
            made = await world_role.world(customer['situation'], written, shapes, seed=str(dialogue['id']))
            test_data = made.value
        except models.ModelError:
            test_data = None
    customer['checks']['worldUsesOpeningIds'] = cards.uses(test_data, raw, customer['opening'])
    found = scenarios.card(topic, dialogue, customer, criteria, sets, reproduces, test_data, scenario)
    return found | {'model': answer.model}


async def built(check: str, progress: Progress = lambda **_: None) -> dict:
    """The cards of the three sets ({cards, sets, catalogRevision}): the conversations with the check's errors, a
    sample of the catalog's episodes stratified by scenario, and rare ones."""
    analysis = storage.documents.load(checks.result(check))
    if not analysis:
        raise RuntimeError(f'У проверки «{checks.NAMES[check]}» ещё нет итога. Сначала проверьте разговоры.')
    if check == checks.TONE:
        draft = storage.documents.load(tone.DRAFT) or {}
        if draft.get('revision') != analysis.get('criteriaRevision'):
            raise RuntimeError(
                'Критерии tone of voice изменились. Сначала проверьте разговоры заново, потом соберите сценарии.'
            )
    found = await catalog.build(progress)
    episodes = found.get('episodes') or {}
    scenario_of = business.scenarios_of(found['categories'])
    chosen: dict[str, tuple[list[str], list[str]]] = {}
    for _, dialogue_id, _, reproduces in scenarios.pick(analysis, set(episodes)):
        chosen.setdefault(dialogue_id, ([], []))[0].append('regression')
        chosen[dialogue_id][1].extend(reproduces)
    sample, manifest = business.allocate(business.strata(episodes), scenarios.REPRESENTATIVE)
    manifests = {'representative': manifest}
    weights = {dialogue_id: weight for dialogue_id, _, weight in sample}
    for dialogue_id, _, _ in sample:
        chosen.setdefault(dialogue_id, ([], []))[0].append('representative')
    acquiring = [i for i, e in episodes.items() if e.get('acquiring')]
    rare, manifests['stress'] = scenarios.stress(storage.dialogues.read(acquiring), set(chosen))
    for dialogue in rare:
        chosen.setdefault(str(dialogue['id']), ([], []))[0].append('stress')
    if not chosen:
        raise RuntimeError('Нет разговоров, из которых можно собрать сценарии.')
    dialogues = {str(d['id']): d for d in storage.dialogues.read(list(chosen))}
    progress(stage='cards', done=0, total=len(chosen), message='Распределяем разговоры по темам проверки')
    with models.about(f'deck:{check}'):
        topic_of = await _topics(analysis, list(dialogues.values()))
    plan = [(i, topic_of[i]) for i in chosen if i in dialogues and (topic_of.get(i) or {}).get('rules')]
    unsorted = [
        {'eligible': False, 'sets': sets, 'sourceDialogueId': i, 'reason': 'не отнесён к теме с критериями'}
        for i, (sets, _) in chosen.items()
        if not (topic_of.get(i) or {}).get('rules')
    ]
    general = scenarios.general_rules(analysis)
    built_cards: dict[int, dict] = {}
    failed: list[dict] = []

    async def one(index: int, dialogue_id: str, topic: dict) -> None:
        sets, reproduces = chosen[dialogue_id]
        episode = episodes.get(dialogue_id) or {}
        scenario = scenario_of.get(episode.get('scenarioId') or '')
        start = episode.get('start') if episode.get('acquiring') else None
        try:
            built_cards[index] = await build_card(
                topic, dialogues[dialogue_id], sets, general, reproduces, scenario, start
            )
        except models.ModelError as error:
            failed.append({'topic': topic['title'], 'dialogueId': dialogue_id, 'error': str(error)})
        missing = f'. Не удалось собрать: {len(failed)}' if failed else ''
        progress(
            stage='cards',
            done=len(built_cards) + len(failed),
            total=len(plan),
            message=f'{BUILDING}{missing}',
            failed=list(failed),
        )

    progress(stage='cards', done=0, total=len(plan), message=BUILDING)
    with models.about(f'deck:{check}'):
        async with asyncio.TaskGroup() as tasks:
            for index, (dialogue_id, topic) in enumerate(plan):
                tasks.create_task(one(index, dialogue_id, topic))
    if not built_cards:
        raise models.ModelError(failed[0]['error'] if failed else 'Ни одна карточка не собрана.')
    ordered = [built_cards[index] for index in sorted(built_cards)]
    return scenarios.deck(ordered + unsorted, manifests, weights) | {'catalogRevision': found['revision']}


async def _topics(analysis: dict, dialogues: list[dict]) -> dict[str, dict]:
    """The check's topic of each conversation; those the check did not sample are sorted into its topics. A check
    with one topic (tone of voice) has every conversation in it."""
    topics = {t['id']: t for t in analysis['topics']}
    if len(topics) == 1:
        return {str(d['id']): next(iter(topics.values())) for d in dialogues}
    known = {str(r['dialogueId']): topics[r['topicId']] for r in analysis['results'] if r['topicId'] in topics}
    new = [d for d in dialogues if str(d['id']) not in known]
    batches = [new[i : i + TOPIC_BATCH] for i in range(0, len(new), TOPIC_BATCH)]
    for placed in await asyncio.gather(*(accuracy.keep_topics(analysis, batch) for batch in batches)):
        for topic in placed:
            known.update({str(i): topics.get(topic['id'], topic) for i in topic['dialogueIds']})
    return known


def listed() -> dict:
    """The scenarios of the deck as tests: {check, cards: [{id, sourceStatus, reproduces, history}]}, in the deck's
    order. Every run of the deck's check is read in full, its conversations included: the results of a scenario are
    spread over the items of all of them, and a run's summary has no items. Fine for a Lab of tens of runs."""
    document = storage.documents.load(DECK) or {}
    cards = document.get('cards') or []
    check = document.get('check')
    analysis = (storage.documents.load(checks.result(check)) if check in checks.RESULTS else None) or {}
    sources = {str(result.get('dialogueId')): result for result in analysis.get('results') or []}
    runs = [record for record in storage.runs.listed() if check is None or checks.of_run(record) == check]
    history = scenarios.played(runs, {card['id'] for card in cards})
    found = []
    for card in cards:
        source = sources.get(str(card.get('sourceDialogueId')))
        found.append(
            {
                'id': card['id'],
                'sourceStatus': (source or {}).get('status'),
                'reproduces': scenarios.reproduced(card, source),
                'history': history[card['id']],
            }
        )
    return {'check': check, 'cards': found}
