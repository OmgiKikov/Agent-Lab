"""Scenarios: the deck of one check, the customers of real conversations in two sets (domain.scenarios), and each
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
from ..domain import profile as profile_domain
from ..roles import card as card_role
from ..roles import world as world_role
from . import Progress, accuracy, catalog, connection, inputs, profile, tone

DECK = checks.DECK  # {check, createdAt, model, cards, sets, catalogRevision}
# What the task says while it builds; the count of the built and the failed ones is the task's own (done of total).
BUILDING = 'Собираем сценарии'
TOPIC_BATCH = 25  # conversations sorted into topics per request: one request for 60 already fails
ROUNDS = 2  # tries of a card the model fails (each try already asks the model again on 429 and 5xx)


def deck() -> list[dict]:
    return (storage.documents.load(DECK) or {}).get('cards') or []


def check() -> str | None:
    """The check whose criteria the deck's scenarios are judged by."""
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
    scenario: dict | None = None,
    start: int | None = None,
    end: int | None = None,
    agent: dict | None = None,
) -> dict:
    """The card of one conversation: its customer from the whole chat, every item found in the log (roles.card,
    domain.cards), its frozen criteria, and the world of its test data when the stand's fixtures are there
    (roles.world); without them, or when the model gives no usable world, the scenario is played against the stand's
    default answers. start: where the catalog's reading put the episode (the card describes the episode its scenario
    was given for); end: where that episode ends, the customer turning to another task. agent: the profile of the
    agent under test (flows/profile.py), the current one by default."""
    agent = agent or profile.current()
    answer = await card_role.card(topic['title'], dialogue, agent, start, end)
    customer = cards.customer(answer.value, dialogue, agent, start, end)
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
    found = scenarios.card(topic, dialogue, customer, criteria, sets, test_data, scenario)
    return found | {'model': answer.model}


async def built(check: str, progress: Progress = lambda **_: None) -> dict:
    """The cards of the two sets ({cards, sets, catalogRevision}): a sample of the catalog's episodes stratified by
    scenario, and rare ones. A card the model fails is built again
    (ROUNDS in all) and then kept in its sets' manifests as failed. A sampled episode left without a card is replaced by
    another of its scenario; when one cannot be, the representative set is incomplete and its cards get no weight."""
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
    groups = business.strata(episodes)
    agent = profile.current()
    chosen, sampled, manifests = _chosen(episodes, groups, agent)
    manifest = manifests['representative']
    deck = _Building(check, analysis, episodes, scenario_of, chosen, progress, agent)
    await deck.make(list(chosen))
    lost = [dialogue_id for dialogue_id in sampled if not deck.carded(dialogue_id)]
    extra = business.replacements(groups, sampled, lost, set(chosen))
    for dialogue_id, key in extra:
        chosen[dialogue_id] = ['representative']
        sampled[dialogue_id] = key
    if extra:
        await deck.make([dialogue_id for dialogue_id, _ in extra])
    weights, coverage = business.weighted(groups, {i: key for i, key in sampled.items() if deck.carded(i)})
    manifest.update(coverage, replacements=[dialogue_id for dialogue_id, _ in extra])
    built_cards = [deck.made[dialogue_id] for dialogue_id in chosen if dialogue_id in deck.made]
    if not any(card.get('eligible', True) for card in built_cards):
        # Nothing to test: the deck saved before stays.
        error = next(iter(deck.failed.values()), {}).get('error')
        raise models.ModelError(error or 'Ни одна карточка не собрана: ни в одном разговоре нет задачи для сценария.')
    lost_builds = [dict(item, sets=chosen[i]) for i, item in deck.failed.items()]
    return scenarios.deck(built_cards, manifests, weights, lost_builds) | {'catalogRevision': found['revision']}


class _Building:
    """The cards of a deck being built: made, by conversation, its card or why it has none (eligible: false); failed,
    by conversation, what the model failed with on its last try."""

    def __init__(
        self,
        check: str,
        analysis: dict,
        episodes: dict[str, dict],
        scenario_of: dict[str, dict],
        chosen: dict[str, list[str]],
        progress: Progress,
        agent: dict,
    ) -> None:
        self.check, self.analysis, self.episodes, self.scenario_of = check, analysis, episodes, scenario_of
        self.chosen, self.progress, self.agent = chosen, progress, agent
        self.general = scenarios.general_rules(analysis)
        self.made: dict[str, dict] = {}
        self.failed: dict[str, dict] = {}

    def carded(self, dialogue_id: str) -> bool:
        return dialogue_id in self.made and self.made[dialogue_id].get('eligible', True)

    async def make(self, ids: list[str]) -> None:
        """The cards of these conversations; one the model fails is tried again, ROUNDS in all."""
        dialogues = {str(d['id']): d for d in storage.dialogues.read(ids)}
        self._told('Распределяем разговоры по темам проверки')
        with models.about(f'deck:{self.check}'):
            topic_of = await _topics(self.analysis, list(dialogues.values()))
        plan = {}
        for dialogue_id in ids:
            # Whether the customer has a task of the agent's domain is the episode reader's decision.
            episode = self.episodes.get(dialogue_id) or {}
            reason = (
                'разговор не прочитан'
                if not episode or episode.get('error')
                else f'вне домена агента: {episode.get("reason") or "нет задачи"}'
                if not business.in_domain(episode)
                else None
                if dialogue_id in dialogues and (topic_of.get(dialogue_id) or {}).get('rules')
                else 'не отнесён к теме с критериями'
            )
            if reason is None:
                plan[dialogue_id] = topic_of[dialogue_id]
            else:
                self.made[dialogue_id] = {
                    'eligible': False,
                    'sets': self.chosen[dialogue_id],
                    'sourceDialogueId': dialogue_id,
                    'reason': reason,
                }
        self._told(BUILDING)
        for _ in range(ROUNDS):
            todo = [dialogue_id for dialogue_id in plan if dialogue_id not in self.made]
            if not todo:
                break
            with models.about(f'deck:{self.check}'):
                async with asyncio.TaskGroup() as tasks:
                    for dialogue_id in todo:
                        tasks.create_task(self._one(dialogues[dialogue_id], plan[dialogue_id]))

    async def _one(self, dialogue: dict, topic: dict) -> None:
        dialogue_id = str(dialogue['id'])
        sets = self.chosen[dialogue_id]
        episode = self.episodes.get(dialogue_id) or {}
        scenario = self.scenario_of.get(episode.get('scenarioId') or '')
        start, end = episode.get('start'), episode.get('end')
        try:
            self.made[dialogue_id] = await build_card(
                topic, dialogue, sets, self.general, scenario, start, end, self.agent
            )
            self.failed.pop(dialogue_id, None)
        except models.ModelError as error:
            self.failed[dialogue_id] = {'topic': topic['title'], 'dialogueId': dialogue_id, 'error': str(error)}
        missing = f'. Не удалось собрать: {len(self.failed)}' if self.failed else ''
        self._told(f'{BUILDING}{missing}', failed=list(self.failed.values()))

    def _told(self, message: str, **more: object) -> None:
        done = len(self.made) + len(self.failed)
        self.progress(stage='cards', done=done, total=len(self.chosen), message=message, **more)


def _chosen(
    episodes: dict[str, dict], groups: dict[str, list[str]], agent: dict
) -> tuple[dict[str, list[str]], dict[str, str], dict]:
    """The conversations of the two sets, each with its sets; the representative sample's scenario of each sampled
    one; the sets' manifests."""
    sample, manifest = business.allocate(groups, scenarios.REPRESENTATIVE)
    manifests = {'representative': manifest}
    sampled = {dialogue_id: key for dialogue_id, key, _ in sample}
    chosen = {dialogue_id: ['representative'] for dialogue_id in sampled}
    found = storage.dialogues.read([i for i, e in episodes.items() if business.in_domain(e)])
    rare, manifests['stress'] = scenarios.stress(found, set(chosen), profile_domain.rare(agent, found))
    for dialogue in rare:
        chosen.setdefault(str(dialogue['id']), []).append('stress')
    if not chosen:
        raise RuntimeError('Нет разговоров, из которых можно собрать сценарии.')
    return chosen, sampled, manifests


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
    """The scenarios of the deck as tests: {check, cards: [{id, history}]}, in the deck's order. Every run of the
    deck's check is read in full, its conversations included: the results of a scenario are spread over the items of
    all of them, and a run's summary has no items. Fine for a Lab of tens of runs."""
    document = storage.documents.load(DECK) or {}
    cards = document.get('cards') or []
    check = document.get('check')
    runs = [record for record in storage.runs.listed() if check is None or checks.of_run(record) == check]
    history = scenarios.played(runs, {card['id'] for card in cards})
    return {'check': check, 'cards': [{'id': card['id'], 'history': history[card['id']]} for card in cards]}
