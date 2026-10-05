"""The export's conversations a check takes and how each is judged: both checks of the real conversations (Точность and
tone of voice) take the same sample of the export and judge each conversation of it by the criteria of its topic."""

import asyncio
from collections.abc import Callable

from .. import config, models, store
from ..domain import export, sampling, verdicts
from ..roles import judge


def sample(count: int) -> list[dict]:
    """The same conversations for the same export, in whatever order its rows come (domain.sampling)."""
    return store.dialogues(sampling.sampled(store.dialogue_ids(), count))


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
    All at once, the model gate would run every first check before any second one and the count would wait minutes."""
    slots = asyncio.Semaphore(config.current().concurrency)

    async def one(dialogue: dict, topic: dict) -> None:
        async with slots:
            result = await judge_dialogue(dialogue, topic)
        done(result)

    async with asyncio.TaskGroup() as tasks:
        for dialogue, topic in todo:
            tasks.create_task(one(dialogue, topic))
