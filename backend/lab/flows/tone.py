"""Tone of voice: the person's rules of communication, criteria grounded in them, and the check of the real
conversations by those criteria, with the same judge as Точность's.

Criteria have a revision: a new one (collected again, clarified, taken from another agent) drops the scenarios built
from tone of voice, while the check made by the previous one stays reviewable in the history. A finished check is
published with its record in the history in one transaction; the answers people gave on verdicts that did not change
are carried to it as rows of their own (storage.reviews).
"""

import asyncio
import uuid

from .. import models, storage
from ..domain import answers, checks, quotes, results, tone
from ..domain.comparison import dataset_fingerprint
from ..roles import tone as role
from ..storage import registry
from . import Progress, conversations, inputs, same_work, severity
from .checks import current

DRAFT = inputs.TONE_DRAFT  # the criteria of the current rules, with their revision
RESULT = checks.result(checks.TONE)  # tone-result.json: its own, beside the accuracy result


def current_policy() -> dict:
    """The rules of communication among the sources; a ValueError without them."""
    found = next((source for source in inputs.sources() if source['kind'] == tone.KIND), None)
    if found is None:
        raise ValueError('Сначала добавьте правила общения.')
    return found


def rules() -> tuple[dict, dict | None] | None:
    """This agent's rules of communication and the criteria collected from them (None until they are collected), or
    None without rules. Criteria collected from other rules are none of theirs. Read defensively: the list of agents
    reads every agent's."""
    items = inputs.sources()
    if not isinstance(items, list):
        return None
    found = next((item for item in items if isinstance(item, dict) and item.get('kind') == tone.KIND), None)
    if found is None or not isinstance(found.get('content'), str):
        return None
    draft = storage.documents.load(DRAFT)
    if not isinstance(draft, dict) or not isinstance(draft.get('criteria'), list):
        return found, None
    return found, draft if draft.get('sourceSha256') == found.get('sha256') else None


def rules_line() -> dict | None:
    """The rules of communication in a line, for taking them into another agent: their name, how many criteria were
    collected from them (0 before that), and their hash, which says whether two agents' rules are the same. None
    without rules."""
    found = rules()
    if found is None:
        return None
    policy, draft = found
    return {
        'name': policy.get('name') or policy.get('origin') or '',
        'criteria': len(draft['criteria']) if draft else 0,
        'sha256': policy.get('sha256'),
    }


def save_draft(draft: dict) -> None:
    """New criteria: a new revision drops the scenarios built from tone of voice, while the check made by the previous
    one stays reviewable."""
    with storage.transaction():
        previous = storage.documents.load(DRAFT) or {}
        storage.documents.save(DRAFT, draft)
        if previous.get('revision') != draft['revision']:
            inputs.drop_deck([checks.TONE])


async def collect_criteria(progress: Progress) -> dict:
    """«Собрать критерии»: criteria from the current rules, saved with a revision of their own."""
    draft = await prepare(progress)
    save_draft(draft)
    return draft


async def prepare(progress: Progress) -> dict:
    """New criteria from the current rules, not saved yet: from their code when they define it, else from the model."""
    source = current_policy()
    if not storage.dialogues.count():
        raise ValueError('Сначала загрузите диалоги.')
    progress(message='Собираем критерии из правил общения')
    criteria = tone.coded_criteria(source)
    model = None
    if not criteria:
        with models.about('criteria:tone'):
            answer = await role.criteria(source)
        criteria, model = answer.value, answer.model
    ensure_active()
    return {
        'revision': uuid.uuid4().hex,
        'createdAt': storage.now(),
        'sourceSha256': source['sha256'],
        'criteria': tone.kept_clarifications(criteria, storage.documents.load(DRAFT), source),
        'model': model,
    }


def take(policy: dict, draft: dict | None) -> bool:
    """Another agent's rules of communication and their criteria, with the clarifications people confirmed, become
    this agent's own as a copy; False when it has them already. The agent's code stays. Other rules replace this
    agent's with what was derived from them (inputs.replace_sources: its criteria, its tone-of-voice result, a deck from
    them; the saved checks stay); the same rules keep their result, which then belongs to the previous criteria. The
    criteria get a version of their own, so no result of the other agent ever matches them. Rules without criteria
    come alone and never take away criteria collected from the same rules."""
    own = rules()
    same = own is not None and own[0]['content'] == policy['content']
    if same and (draft is None or (own[1] or {}).get('criteria') == draft['criteria']):
        return False
    if not same:
        inputs.replace_sources([*(item for item in inputs.sources() if item['kind'] != tone.KIND), policy])
    if draft is not None:
        copied = {key: value for key, value in draft.items() if key != 'updatedAt'}
        save_draft(copied | {'revision': uuid.uuid4().hex, 'createdAt': storage.now()})
    return True


def copied_from(agent_id: str) -> tuple[dict, tuple[dict, dict | None], dict[str, bool], dict]:
    """What «Взять у другого агента» copies, read from that agent's database: the agent, its rules with their criteria,
    and its decisions and the model's proposals on serious errors. LookupError: no such agent; ValueError: the same
    agent, or one without rules."""
    source = registry.get(agent_id)
    if source is None:
        raise LookupError('Агент не найден')
    if registry.db_of(source['id']) == storage.db.database():
        raise ValueError('Правила можно взять только у другого агента.')
    with registry.using(source['id']):
        found = rules()
        marks = storage.severity.marks()[checks.TONE]
        proposed = storage.severity.proposed()[checks.TONE]
    if found is None:
        raise ValueError(f'У агента «{source["name"]}» нет правил общения.')
    return source, found, marks, proposed


def copy(found: tuple[dict, dict | None], marks: dict[str, bool], proposed: dict) -> dict:
    """The rules, criteria and marks another agent has (copied_from) become this agent's own. Serious or minor belongs
    to the criteria (problems.rule_key): a person's decisions and the model's proposals come with criteria, never with
    rules alone, and other ones on the same criteria are a change. `unchanged` when this agent had all of it already."""
    changed = take(*found)
    own = (storage.severity.marks()[checks.TONE], storage.severity.proposed()[checks.TONE]['proposals'])
    if found[1] is not None and own != (marks, proposed['proposals']):
        storage.severity.take(checks.TONE, marks, proposed)
        changed = True
    return {'ok': True, 'unchanged': not changed}


def ensure_active() -> None:
    """A dependency swallowing cancellation must not publish a completed result."""
    task = asyncio.current_task()
    if task and task.cancelling():
        raise asyncio.CancelledError


def selection(rule_ids: list[str], revision: str | None = None) -> list[dict]:
    draft = storage.documents.load(DRAFT)
    if not draft or draft['sourceSha256'] != current_policy()['sha256']:
        raise ValueError('Сначала соберите критерии по текущим правилам общения.')
    if revision is not None and revision != draft['revision']:
        raise ValueError('Критерии изменились. Обновите страницу перед проверкой.')
    by_id = {rule['id']: rule for rule in draft['criteria']}
    if not rule_ids or len(set(rule_ids)) != len(rule_ids) or not set(rule_ids) <= by_id.keys():
        raise ValueError('Выберите хотя бы один критерий из текущей проверки.')
    return [by_id[key] for key in rule_ids]


def clarified(revision: str, rule_id: str, text: str) -> dict:
    """Only an explicit human confirmation changes the rubric, without touching source evidence."""
    text = text.strip()
    if not 10 <= len(text) <= 2000:
        raise ValueError('В уточнении должно быть от 10 до 2000 символов.')
    selection([rule_id], revision)
    draft = storage.documents.load(DRAFT)
    rule = next(rule for rule in draft['criteria'] if rule['id'] == rule_id)
    entries = rule.setdefault('clarifications', [])
    if text in entries:
        raise ValueError('Такое уточнение уже сохранено.')
    if len(entries) >= 20:
        raise ValueError('Сохранено уже 20 уточнений. Соберите критерии заново из обновлённых правил.')
    entries.append(text)
    draft.update(revision=uuid.uuid4().hex, updatedAt=storage.now())
    return draft


def clarify(revision: str, rule_id: str, text: str) -> dict:
    """A person's clarification of a criterion, saved as a new revision of the criteria."""
    draft = clarified(revision, rule_id, text)
    save_draft(draft)
    return draft


def carry_decisions(judged: list[dict], criteria: list[dict], dialogues: list[dict]) -> None:
    """A person's latest decision on a criterion of a conversation stays while the verdict is the same (an error with
    the same words of the agent, quotes.same_finding) and the judge saw the same: that conversation, that criterion
    with its clarifications. It is read from the saved checks, so a check in between that could not decide it does not
    lose it, and clarifying another criterion does not drop it. A new export that gives the id to another conversation
    gets nothing."""
    rows = {(str(result['dialogueId']), row['ruleId']): row for result in judged for row in result['rules']}
    shown = {str(dialogue['id']): dialogue for dialogue in dialogues}
    seen = {rule['id']: tone.for_judging(rule) for rule in criteria}
    saved: dict[str, tuple[dict, dict, dict]] = {}
    latest: dict[tuple[str, str], tuple[str | None, str | None, str | None]] = {}
    for check_id, dialogue_id, rule_id, decision in storage.reviews.on_saved_checks(checks.TONE):
        key = (dialogue_id, rule_id)
        if key in latest or key not in rows:
            continue
        if check_id not in saved:
            saved[check_id] = tone.judged(storage.history.get(checks.TONE, check_id) or {})
        talks, read, said = saved[check_id]
        if talks.get(dialogue_id) == shown.get(dialogue_id) and read.get(rule_id) == seen.get(rule_id):
            latest[key] = (*said.get(key, (None, None)), decision)
    for key, (status, quote, decision) in latest.items():
        row = rows[key]
        if decision and status == row['status'] and quotes.same_finding(status, quote, row.get('agentQuote')):
            row['review'] = decision


async def judge(dialogues: list[dict], topic: dict, progress: Progress, kept: dict | None = None) -> list[dict]:
    """Every conversation by the topic's criteria, in the order of the sample, the count moving as each is judged; a
    task continued counts the verdicts it kept (its steps) from the start (conversations.judge_each)."""
    found: list[dict] = []

    def done(result: dict) -> None:
        found.append(result)
        progress(done=len(found), total=len(dialogues), message='Проверяем разговоры')

    await conversations.judge_each([(dialogue, topic) for dialogue in dialogues], done, kept)
    order = {str(dialogue['id']): index for index, dialogue in enumerate(dialogues)}
    return sorted(found, key=lambda result: order[str(result['dialogueId'])])


def fingerprint(given: dict) -> str:
    """The same check of tone of voice (work.KINDS): the same criteria, the ones chosen of the revision that is
    current (criteria collected again or clarified since make other work), on the same material
    (conversations.same_material)."""
    return same_work(
        check=checks.TONE,
        revision=given['revision'],
        current=(storage.documents.load(DRAFT) or {}).get('revision'),
        rules=sorted(given['ruleIds']),
        **conversations.same_material(given['count']),
    )


async def check(criteria: list[dict], count: int, progress: Progress, *, propose: bool = False) -> dict | None:
    """A check of tone of voice by these criteria (selection), published with its record in the history; then, when
    the screens ask, the model proposes which of its errors are serious. A task taken up after a restart that finds its
    check published goes on to the proposals (conversations.published_once). The result published here, None when it
    was published before."""

    async def made(check_id: str) -> dict:
        result = await assess(criteria, count, progress, check_id)
        commit(result)
        return result

    result = await conversations.published_once(checks.TONE, made)
    if propose:
        await severity.proposed_after(checks.TONE, progress)
    return result


async def assess(criteria: list[dict], count: int, progress: Progress, check_id: str | None = None) -> dict:
    """A check of tone of voice: its calls to the models are about it in the journal (models.about)."""
    check_id = check_id or uuid.uuid4().hex
    with models.about(f'check:{check_id}'):
        return await _assess(check_id, criteria, count, progress)


async def _assess(check_id: str, criteria: list[dict], count: int, progress: Progress) -> dict:
    source, draft = current_policy(), storage.documents.load(DRAFT)
    dialogues = conversations.sample(count)
    if not dialogues:
        raise ValueError('Сначала загрузите диалоги.')
    started = storage.now()
    topic = {'id': 't1', 'title': checks.TONE_TOPIC, 'rules': criteria, 'dialogueIds': [d['id'] for d in dialogues]}
    kept = storage.tasks.steps()
    progress(done=conversations.judged_before(dialogues, kept), total=len(dialogues), message='Проверяем разговоры')
    judged = await judge(dialogues, {**topic, 'rules': [tone.for_judging(rule) for rule in criteria]}, progress, kept)
    ensure_active()
    previous = current(checks.TONE) or {}
    results.ensure_answered(judged, previous)
    # The live result carries its own answers with the same criteria, as before: a result saved before the history of
    # checks keeps them only in itself. The history then adds what a check in between lost or what another criterion's
    # clarification would have dropped.
    if previous.get('criteriaRevision') == draft['revision']:
        results.carry_reviews(previous, judged)
    carry_decisions(judged, criteria, dialogues)
    return {
        'purpose': tone.KIND,
        'checkId': check_id,
        'criteriaRevision': draft['revision'],
        'criteriaFingerprint': tone.criteria_fingerprint(criteria, source),
        'datasetFingerprint': dataset_fingerprint(dialogues),
        'startedAt': started,
        'finishedAt': storage.now(),
        'rulesSince': draft['createdAt'],
        'model': models.models_used(judged),
        'sampled': len(dialogues),
        'unassigned': 0,
        'droppedRules': 0,
        'topics': [topic],
        'results': judged,
        'sources': [
            {key: source[key] for key in ('id', 'kind', 'origin', 'sha256')}
            | {'chars': len(source['content']), 'rules': len(criteria)}
        ],
        'summary': results.summarize(judged, [topic], len(dialogues)),
    }


def commit(result: dict) -> None:
    """Publish a finished check with its record in the history (publish). The materials it was made of must still be
    the current ones."""
    ensure_active()
    source = current_policy()
    draft = storage.documents.load(DRAFT) or {}
    dialogues = conversations.sample(result['sampled'])
    criteria = result['topics'][0]['rules']
    if (
        result['criteriaRevision'] != draft.get('revision')
        or result['criteriaFingerprint'] != tone.criteria_fingerprint(criteria, source)
        or result['datasetFingerprint'] != dataset_fingerprint(dialogues)
    ):
        raise ValueError('Материалы проверки изменились. Запустите проверку заново.')
    with storage.transaction():
        previous = storage.history.latest(checks.TONE)
        export = {'file': storage.dialogues.meta().get('file'), 'total': storage.dialogues.count()}
        publish(result, tone.snapshot(result, dialogues, criteria, source, export, previous))


def publish(result: dict, record: dict) -> None:
    """The result of tone of voice and its immutable record in the history (domain.tone.snapshot), in one transaction;
    the scenarios built from the previous result go. The answers carried into it are rows under its saved check (the
    answers on that record start with them), the result and the record keep the verdicts."""
    kept, carried = answers.taken_from_result(result)
    with storage.transaction():
        storage.history.save(checks.TONE, {**record, 'result': kept})
        storage.documents.save(RESULT, kept)
        inputs.drop_deck([checks.TONE])
        at = record['check']['finishedAt']
        storage.reviews.give(answers.LOG, record['check']['id'], carried, author=storage.reviews.LAB, at=at)
