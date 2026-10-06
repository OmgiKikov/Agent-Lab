"""Точность: the real conversations from the export judged by criteria grounded in the agent's prompts and tools.

The planner extracts the criteria once and they are frozen: the next check reuses them and keeps every known
conversation in its topic, so two checks are measured by the same criteria; «Новые правила» (replan) extracts them
again. A new export keeps them too (checks.CODE_CRITERIA): its conversations are sorted into the same topics by the
router, and the two checks compare. A finished check is published with its record in the history, in one transaction;
the answers people gave on verdicts that did not change are carried to it as rows of their own (storage.reviews).
"""

import uuid
from collections import Counter

from .. import models, storage
from ..domain import accuracy, answers, checks, results
from ..domain.comparison import dataset_fingerprint
from ..roles import planner
from . import Progress, conversations, inputs, same_work, severity
from .checks import current

RESULT = checks.result(checks.CODE)  # discover.json: the accuracy result; tone of voice keeps its own
TOPICS = 'topics'  # the step the planned topics are kept under
TASK = 'Проверить ответы чат-бота эквайринга СберБизнеса на реальных обращениях клиентов'


async def check(count: int, progress: Progress, *, replan: bool = False, propose: bool = False) -> dict | None:
    """A check of Точность, published with its record in the history; then, when the screens ask, the model proposes
    which of its errors are serious (severity.proposed_after). Made by a task, the check takes the task's id as its
    own: a task taken up after a restart that finds its check published goes on to the proposals, and never publishes
    it twice. The result published here, None when it was published before."""
    check_id = storage.tasks.current_id() or uuid.uuid4().hex
    result = None
    if storage.history.get(checks.CODE, check_id) is None:
        result = await assess(count, progress, replan, check_id)
        commit(result, new_criteria=replan)
    if propose:
        await severity.proposed_after(checks.CODE, progress)
    return result


def fingerprint(given: dict) -> str:
    """The same check of Точность (work.KINDS): from the same criteria (the result they are kept from, or extracted
    anew from the same code) on the same material (conversations.same_material)."""
    before = current(checks.CODE) or storage.documents.load(checks.CODE_CRITERIA) or {}
    code = sorted(source.get('sha256') or '' for source in inputs.sources() if source['kind'] != checks.TONE_OF_VOICE)
    return same_work(
        check=checks.CODE,
        replan=bool(given.get('replan')),
        criteria=before.get('checkId') or before.get('startedAt'),
        code=code,
        **conversations.same_material(given['count']),
    )


async def plan_topics(srcs: list[dict], dialogues: list[dict]) -> tuple[list[dict], int]:
    """New topics and criteria from the sources; every sampled conversation is put into one topic. A conversation the
    planner left out is in no topic and counts as «не удалось проверить» (unassigned); one it repeated stays in its
    first topic. With how many of the criteria were dropped for a quote their source does not have."""
    answer = await planner.plan(TASK, srcs, planner.requests(dialogues))
    topics, dropped = accuracy.ground(answer.value, srcs)
    topics = [t for t in topics if t['rules']]
    real, placed = planner.short_ids(dialogues), set()
    for topic in topics:
        ids = [real[str(i)] for i in topic.get('dialogueIds') or [] if str(i) in real]
        topic['dialogueIds'] = [i for i in dict.fromkeys(ids) if i not in placed]
        placed.update(topic['dialogueIds'])
    return topics, dropped


async def keep_topics(previous: dict, dialogues: list[dict]) -> list[dict]:
    """The frozen topics: a known conversation keeps its topic, new ones are sorted into the existing topics."""
    known = {str(r['dialogueId']): r['topicId'] for r in previous.get('results') or []}
    new = [d for d in dialogues if str(d['id']) not in known]
    topics = [dict(t, dialogueIds=[]) for t in previous['topics']]
    if new:
        real = planner.short_ids(new)
        answer = await planner.place(topics, planner.requests(new))
        for request, topic_id in answer.value:
            known.setdefault(real[request], topic_id)
    for topic in topics:
        topic['dialogueIds'] = [str(d['id']) for d in dialogues if known.get(str(d['id'])) == topic['id']]
    return topics


async def assess(
    count: int = 60, progress: Progress = lambda **_: None, replan: bool = False, check_id: str | None = None
) -> dict:
    """The result of a check of Точность, not published yet (commit). Its calls to the models are about it in the
    journal (models.about)."""
    check_id = check_id or uuid.uuid4().hex
    with models.about(f'check:{check_id}'):
        return await _assess(check_id, count, progress, replan)


async def _assess(check_id: str, count: int, progress: Progress, replan: bool) -> dict:
    # The criteria come from the previous result, else from the ones a new export kept (checks.CODE_CRITERIA).
    result_before = current(checks.CODE) or {}
    previous = result_before or storage.documents.load(checks.CODE_CRITERIA) or {}
    # The rules of communication have their own check (flows/tone.py); the criteria here come from the agent's code.
    srcs = [source for source in inputs.sources() if source['kind'] != checks.TONE_OF_VOICE]
    if not srcs:
        raise RuntimeError('Код агента ещё не прочитан. Прочитайте его в разделе «Агент».')
    dialogues = conversations.sample(count)
    if not dialogues:
        raise RuntimeError('Нет разговоров для проверки. Сначала загрузите диалоги.')
    planned = storage.tasks.steps().get(TOPICS)
    if planned is None:
        planned = storage.tasks.keep(TOPICS, await plan(previous, result_before, srcs, dialogues, progress, replan))
    topics, dropped, rules_since, started = (
        planned['topics'],
        planned['dropped'],
        planned['rulesSince'],
        planned['startedAt'],
    )

    topic_of = {}
    for topic in topics:
        for dialogue_id in topic['dialogueIds']:
            topic_of.setdefault(dialogue_id, topic)
    todo = [(d, topic_of[str(d['id'])]) for d in dialogues if str(d['id']) in topic_of]
    before = conversations.judged_before([dialogue for dialogue, _ in todo])
    progress(stage='judge', done=before, total=len(todo), message='Проверяем разговоры')
    judged = []

    def done(result: dict) -> None:
        judged.append(result)
        progress(stage='judge', done=len(judged), total=len(todo), message='Проверяем разговоры')

    await conversations.judge_each(todo, done)
    results.ensure_answered(judged, result_before)
    order = {str(d['id']): i for i, d in enumerate(dialogues)}
    judged.sort(key=lambda r: order.get(str(r['dialogueId']), 0))
    if previous.get('topics') and not replan:
        results.carry_reviews(previous, judged)
    rule_count = Counter(rule.get('sourceId') for topic in topics for rule in topic['rules'])
    return {
        # The check's own id and the conversations it judged: its record in the history (commit).
        'checkId': check_id,
        'datasetFingerprint': dataset_fingerprint([dialogue for dialogue, _ in todo]),
        'startedAt': started,
        'finishedAt': storage.now(),
        'model': models.models_used(judged),
        'rulesSince': rules_since,
        'sources': [
            {
                'id': s['id'],
                'kind': s['kind'],
                'origin': s.get('origin', s.get('name')),
                'sha256': s.get('sha256'),
                'chars': len(s['content']),
                'rules': rule_count[s['id']],
            }
            for s in srcs
        ],
        'sampled': len(dialogues),
        'unassigned': len(dialogues) - len(todo),
        'droppedRules': dropped,
        'topics': topics,
        'results': judged,
        'summary': results.summarize(judged, topics, len(dialogues)),
    }


async def plan(
    previous: dict, result_before: dict, srcs: list[dict], dialogues: list[dict], progress: Progress, replan: bool
) -> dict:
    """The topics of the check with their criteria and the conversations of each: the frozen ones, or extracted anew.
    Kept as a step of the task (TOPICS): a task continued judges by the topics it planned, never planned again."""
    started = storage.now()
    if previous.get('topics') and not replan:
        progress(stage='plan', done=0, total=len(dialogues), message='Распределяем разговоры по темам')
        topics = await keep_topics(previous, dialogues)
        dropped = previous.get('droppedRules', 0)
        rules_since = previous.get('rulesSince') or previous.get('startedAt')
    else:
        progress(stage='plan', done=0, total=len(dialogues), message='Извлекаем критерии из кода агента')
        topics, dropped = await plan_topics(srcs, dialogues)
        accuracy.ensure_grounded(topics, result_before)
        rules_since = started
    return {'topics': topics, 'dropped': dropped, 'rulesSince': rules_since, 'startedAt': started}


def commit(result: dict, *, new_criteria: bool) -> None:
    """Publish a finished check of Точность together with its record in the history. Its conversations are the
    export's sample it was made of; an export replaced meanwhile makes the check stale."""
    judged = {str(item['dialogueId']) for item in result['results']}
    dialogues = [dialogue for dialogue in conversations.sample(result['sampled']) if str(dialogue['id']) in judged]
    if dataset_fingerprint(dialogues) != result['datasetFingerprint']:
        raise ValueError('Разговоры изменились во время проверки. Запустите проверку заново.')
    with storage.transaction():
        previous = storage.history.latest(checks.CODE)
        export = storage.dialogues.meta()
        record = accuracy.saved(result, dialogues, export.get('file'), storage.dialogues.count(), previous)
        publish(result, record, new_criteria=new_criteria)


def publish(result: dict, record: dict | None = None, *, new_criteria: bool) -> None:
    """The result of Точность and its record in the history (domain.accuracy.saved), in one transaction; the answers
    carried into it are rows under its saved check, the result and the record keep the verdicts. Criteria extracted
    anew no longer match the scenarios built from the old ones, so those go with it; a deck from tone of voice stays."""
    kept, carried = answers.taken_from_result(result)
    with storage.transaction():
        if record is not None:
            storage.history.save(checks.CODE, {**record, 'result': kept})
        storage.documents.save(RESULT, kept)
        at = kept.get('finishedAt')
        storage.reviews.give(
            answers.LOG, answers.record_of(checks.CODE, kept), carried, author=storage.reviews.LAB, at=at
        )
        if new_criteria:
            inputs.drop_deck([checks.CODE])
