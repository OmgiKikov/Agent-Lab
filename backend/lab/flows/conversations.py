"""The conversations a check takes and how each is judged: both checks of the real conversations (Точность and tone of
voice) take the same sample of the export chosen for them and judge each conversation of it by the criteria of its
topic."""

import asyncio
import uuid
from collections.abc import Awaitable, Callable

from .. import config, models, storage
from ..domain import export, sampling, verdicts
from ..roles import judge


async def published_once(check: str, made: Callable[[str], Awaitable[dict]]) -> dict | None:
    """A check made and published once (made: its result, published, from its id). Made by a task, the check takes
    the task's id as its own: a task taken up after a restart that finds its check in the history does not make it
    again, and never publishes it twice. The result made here, None when it was published before."""
    check_id = storage.tasks.current_id() or uuid.uuid4().hex
    result = None
    if storage.history.get(check, check_id) is None:
        result = await made(check_id)
    storage.tasks.keep('published', check_id)  # a finished part of the task
    return result


def chosen(export_id: str | None) -> dict:
    """The export a check is made of: the one asked for, else the newest (a task kept before exports names none)."""
    export = storage.exports.get(export_id) if export_id else storage.exports.newest()
    if export is None:
        raise ValueError('Выгрузка удалена. Выберите другую.' if export_id else 'Сначала загрузите выгрузку.')
    return export


def export_of(result: dict | None) -> str | None:
    """The export a result was made of. A result of an older database got its export when the database became one
    with exports (storage.schema); one that names none is of no export, and no export's conversation is shown with it:
    the same id in a newer export is another conversation."""
    return ((result or {}).get('export') or {}).get('id')


def sample(export_id: str, count: int) -> list[dict]:
    """The same conversations of the same export, in whatever order its rows come (domain.sampling)."""
    return storage.exports.read(export_id, sampling.sampled(storage.exports.ids(export_id), count))


def same_material(export_id: str | None, count: int) -> dict:
    """What a check of an export's sample is made of besides its criteria: the export as it was uploaded (its file,
    when and how many conversations — what the one export of the time before exports had, so a check stopped then
    continues), the size of the sample and the models that judge. Two checks with the same, and the same criteria, are
    the same work: a stopped one continues (flows.same_work). ValueError when the export is gone. Read without the
    conversations: the screens ask it at every look."""
    export = chosen(export_id)
    return {
        'export': [export['file'], export['uploadedAt'], export['total']],
        'count': count,
        'judges': [models.endpoints().main, models.second_judge()],
    }


async def judge_dialogue(dialogue: dict, topic: dict) -> dict:
    """One conversation judged by the criteria of its topic, by both judges. A conversation the model could not judge
    stays «не удалось проверить», with the reason, and never fails the check."""
    rules, shown = topic['rules'], export.conversation(dialogue)
    try:
        verdict = await judge.log_verdict(rules, shown)
        rows, status, model, version = verdict.rows, verdict.status, verdict.model, verdict.version
        second, error = await judge.second_opinion(judge.log_verdict, rules, shown), None
    except models.ModelError as exc:
        rows = verdicts.checked([], rules, '')
        status, second, error, model, version = verdicts.verdict_of(rows), None, str(exc), None, None
    return {
        'dialogueId': dialogue['id'],
        'topicId': topic['id'],
        'status': status,
        'rules': rows,
        'second': second,
        'opening': dialogue['messages'][0]['content'],
        'error': error,
        'model': model,
        'judgeVersion': version,
    }


async def judge_each(todo: list[tuple[dict, dict]], done: Callable[[dict], None], kept: dict | None = None) -> None:
    """Judge conversations a few at a time, each with both checks, so the count moves from the first seconds.
    All at once, the model gate would run every first check before any second one and the count would wait minutes.

    Each verdict is kept as a step of the task the moment it is made (storage.tasks.keep): a task continued after a
    stop or a restart is given the verdicts it kept first (kept: its steps, when the caller read them), and judges only
    the rest. A conversation the model could not judge is not kept, so it is tried again then."""
    kept = storage.tasks.steps() if kept is None else kept
    for dialogue, _ in todo:
        if step(dialogue['id']) in kept:
            done(kept[step(dialogue['id'])])
    slots = asyncio.Semaphore(config.current().concurrency)

    async def one(dialogue: dict, topic: dict) -> None:
        async with slots:
            result = await judge_dialogue(dialogue, topic)
        if not result.get('error'):
            storage.tasks.keep(step(dialogue['id']), result)
        done(result)

    async with asyncio.TaskGroup() as tasks:
        for dialogue, topic in todo:
            if step(dialogue['id']) not in kept:
                tasks.create_task(one(dialogue, topic))


def step(dialogue_id: object) -> str:
    """The key a conversation's verdict is kept under in its task."""
    return f'dialogue:{dialogue_id}'


def judged_before(dialogues: list[dict], kept: dict) -> int:
    """How many of these conversations the task judged already (kept: its steps): where its count starts when it is
    continued."""
    return sum(step(dialogue['id']) in kept for dialogue in dialogues)
