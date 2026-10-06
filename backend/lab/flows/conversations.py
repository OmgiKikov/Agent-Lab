"""The export's conversations a check takes and how each is judged: both checks of the real conversations (Точность and
tone of voice) take the same sample of the export and judge each conversation of it by the criteria of its topic."""

import asyncio
from collections.abc import Callable

from .. import config, models, storage
from ..domain import export, sampling, verdicts
from ..roles import judge


def sample(count: int) -> list[dict]:
    """The same conversations for the same export, in whatever order its rows come (domain.sampling)."""
    return storage.dialogues.read(sample_ids(count))


def sample_ids(count: int) -> list[str]:
    """The ids of the sample, read without the conversations."""
    return sampling.sampled(storage.dialogues.ids(), count)


def same_material(count: int) -> dict:
    """What a check of the export's sample is made of besides its criteria: the conversations of the sample, the
    export they come from and the models that judge. Two checks with the same, and the same criteria, are the same
    work: a stopped one continues (flows.same_work)."""
    export = storage.dialogues.meta()
    return {
        'sample': sample_ids(count),
        'export': [export.get('file'), export.get('updatedAt')],
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


async def judge_each(todo: list[tuple[dict, dict]], done: Callable[[dict], None]) -> None:
    """Judge conversations a few at a time, each with both checks, so the count moves from the first seconds.
    All at once, the model gate would run every first check before any second one and the count would wait minutes.

    Each verdict is kept as a step of the task the moment it is made (storage.tasks.keep): a task continued after a
    stop or a restart is given the verdicts it kept first, and judges only the rest. A conversation the model could not
    judge is not kept, so it is tried again then."""
    kept = storage.tasks.steps()
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


def judged_before(dialogues: list[dict]) -> int:
    """How many of these conversations the task judged already: where its count starts when it is continued."""
    kept = storage.tasks.steps()
    return sum(step(dialogue['id']) in kept for dialogue in dialogues)
