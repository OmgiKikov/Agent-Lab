"""Scenarios: the deck built from the errors one check found in the real conversations (domain.scenarios), and each
scenario as a test, with its result in every run of the deck's check.

A card the model fails to build is reported in the progress and never cancels the others; only a deck with no card is
an error. The deck names the check it was built from: a run is measured by that check's criteria.
"""

import asyncio
from collections.abc import Sequence

from .. import models, store
from ..agents import world
from ..domain import checks, scenarios
from ..roles import scenario as scenario_role
from ..roles import world as world_role
from . import Progress, connection, inputs, tone

DECK = checks.DECK  # {check, createdAt, model, cards}
# What the task says while it builds; the count of the built and the failed ones is the task's own (done of total).
BUILDING = 'Собираем сценарии'


def deck() -> list[dict]:
    return (store.load(DECK) or {}).get('cards') or []


def check() -> str | None:
    """The check whose errors the deck was built from."""
    return (store.load(DECK) or {}).get('check')


def remember_openings(openings: dict[str, dict[str, str]]) -> None:
    """Keep the openings rewritten for customer types (simulation.prepare_openings) in the cards."""

    with store.transaction():
        value = store.load(DECK) or {}
        for card in value.get('cards') or []:
            card.setdefault('openings', {}).update(openings.get(card['id'], {}))
        store.save(DECK, value)


def chosen_check(asked: str | None) -> str | None:
    """The check to build scenarios from: the one asked for, else the only check with a result (None without one). A
    ValueError when both have one and none was asked for."""
    if asked is not None:
        return asked
    found = [key for key in checks.RESULTS if store.load(checks.result(key))]
    if len(found) > 1:
        raise ValueError('Выберите, из какой проверки собрать сценарии.')
    return next(iter(found), None)


async def build(check: str | None, progress: Progress) -> list[dict]:
    """«Собрать сценарии»: the deck from the errors of the check, saved with the check it names."""
    if check is None:
        raise RuntimeError('Сценарии собираются из найденных ошибок. Сначала проверьте разговоры.')
    cards = await built(check, progress)
    document = {'check': check, 'createdAt': store.now(), 'model': models.models_used(cards), 'cards': cards}
    store.save(DECK, document)
    return cards


async def build_card(
    topic: dict, dialogue: dict, origin: str, general: Sequence[dict] = (), reproduces: Sequence[str] = ()
) -> dict:
    """The card of one conversation: its situation from the customer's words (roles.scenario), its frozen criteria,
    and the world of its test data when the stand's fixtures are there (roles.world); without them, or when the model
    gives no usable world, the scenario is played against the stand's default answers."""
    customer = [m['content'] for m in dialogue['messages'] if m['role'] == 'user']
    answer = await scenario_role.scenario(topic['title'], customer)
    prompts = '\n'.join(source['content'] for source in inputs.sources())
    criteria = scenarios.criteria(topic, general, prompts)
    test_data, shapes = None, world.templates(connection.repo())
    if shapes is not None:
        try:
            test_data = (await world_role.world(answer.value.situation, customer, shapes)).value
        except models.ModelError:
            test_data = None
    situation = (answer.value.name, answer.value.situation)
    return scenarios.card(topic, dialogue, situation, criteria, origin, reproduces, test_data) | {'model': answer.model}


async def built(check: str, progress: Progress = lambda **_: None) -> list[dict]:
    """The cards built from the conversations picked in the check's result."""
    analysis = store.load(checks.result(check))
    if not analysis:
        raise RuntimeError(f'У проверки «{checks.NAMES[check]}» ещё нет итога. Сначала проверьте разговоры.')
    if check == checks.TONE:
        draft = store.load(tone.DRAFT) or {}
        if draft.get('revision') != analysis.get('criteriaRevision'):
            raise RuntimeError(
                'Критерии tone of voice изменились. Сначала проверьте разговоры заново, потом соберите сценарии.'
            )
    dialogues = {str(dialogue['id']): dialogue for dialogue in store.dialogues()}
    picks = scenarios.pick(analysis, dialogues)
    if not picks:
        raise RuntimeError('Нет разговоров, из которых можно собрать сценарии.')
    general = scenarios.general_rules(analysis)
    cards: dict[int, dict] = {}
    failed: list[dict] = []

    async def one(index: int, topic: dict, dialogue_id: str, origin: str, reproduces: Sequence[str] = ()) -> None:
        try:
            cards[index] = await build_card(topic, dialogues[dialogue_id], origin, general, reproduces)
        except models.ModelError as error:
            failed.append({'topic': topic['title'], 'dialogueId': dialogue_id, 'error': str(error)})
        missing = f'. Не удалось собрать: {len(failed)}' if failed else ''
        progress(
            stage='cards',
            done=len(cards) + len(failed),
            total=len(picks),
            message=f'{BUILDING}{missing}',
            failed=list(failed),
        )

    progress(stage='cards', done=0, total=len(picks), message=BUILDING)
    with models.about(f'deck:{check}'):
        async with asyncio.TaskGroup() as tasks:
            for index, chosen in enumerate(picks):
                tasks.create_task(one(index, *chosen))
    if not cards:
        raise models.ModelError(failed[0]['error'])
    return [cards[index] for index in sorted(cards)]


def listed() -> dict:
    """The scenarios of the deck as tests: {check, cards: [{id, sourceStatus, reproduces, history}]}, in the deck's
    order. Every run of the deck's check is read in full, its conversations included: the results of a scenario are
    spread over the items of all of them, and a run's summary has no items. Fine for a Lab of tens of runs."""
    document = store.load(DECK) or {}
    cards = document.get('cards') or []
    check = document.get('check')
    analysis = (store.load(checks.result(check)) if check in checks.RESULTS else None) or {}
    sources = {str(result.get('dialogueId')): result for result in analysis.get('results') or []}
    runs = [record for record in store.runs() if check is None or checks.of_run(record) == check]
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
