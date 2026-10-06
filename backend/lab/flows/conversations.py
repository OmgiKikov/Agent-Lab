"""The export's conversations a check takes and how each is judged: both checks of the real conversations (Точность and
tone of voice) take the same sample of the export and judge each conversation of it by the criteria of its topic."""

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


def sample(count: int) -> list[dict]:
    """The same conversations for the same export, in whatever order its rows come (domain.sampling)."""
    return storage.dialogues.read(sampling.sampled(storage.dialogues.ids(), count))


def same_material(count: int) -> dict:
    """What a check of the export's sample is made of besides its criteria: the export as it was uploaded (an upload
    stamps its time with the conversations, and the sample of an export is always the same), the size of the sample and
    the models that judge. Two checks with the same, and the same criteria, are the same work: a stopped one continues
    (flows.same_work). Read without the conversations: the screens ask it at every look."""
    export = storage.dialogues.meta()
    return {
        'export': [export.get('file'), export.get('updatedAt'), storage.dialogues.count()],
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
