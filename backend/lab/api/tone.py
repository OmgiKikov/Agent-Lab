"""Tone of voice: the person's rules of communication (written, read from a file or taken from another agent), the
criteria collected from them and clarified, the check of the conversations by them, its history, and the model's
suggestions: a better reply where it found an error, a clarification of a criterion people corrected it by."""

import asyncio
from collections.abc import Awaitable, Callable

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from .. import models, storage
from ..domain import checks, policy_files
from ..flows import Progress, advice, tone
from ..jobs import BusyError
from . import work
from .base import Jobs, uploaded
from .checks import saved

router = APIRouter()


class TonePolicyCommand(BaseModel):
    text: str = Field(min_length=20, max_length=50000)
    name: str = Field(default='Правила общения', min_length=1, max_length=160)


class ToneCopyCommand(BaseModel):
    agent: str = Field(min_length=1, max_length=120)


class ToneCheckCommand(BaseModel):
    ruleIds: list[str] = Field(min_length=1, max_length=20)
    count: int = Field(default=300, ge=1, le=300)
    revision: str | None = None
    # After the check the model proposes which errors are serious (severity.propose); the screens ask for it.
    propose: bool = False


class ToneAdviceCommand(BaseModel):
    """«Как ответить правильно» on an error of the result the person saw (finishedAt)."""

    finishedAt: str = Field(min_length=1)
    dialogueId: str = Field(min_length=1)
    ruleId: str = Field(min_length=1)


class ToneClarifyCommand(BaseModel):
    """«Уточнить критерий»: a clarification proposed from every case of the result the person saw (finishedAt) where
    people corrected the model by the criterion, with the person's note on what it gets wrong (may be empty)."""

    finishedAt: str = Field(min_length=1)
    ruleId: str = Field(min_length=1)
    note: str = Field(default='', max_length=2000)


class ToneClarificationCommand(BaseModel):
    revision: str = Field(min_length=1)
    ruleId: str = Field(min_length=1)
    text: str = Field(min_length=10, max_length=2000)


@router.post('/api/tone-of-voice/policy')
async def save_tone_policy(jobs: Jobs, payload: TonePolicyCommand) -> dict:
    """New rules of communication: refused before they replace anything when their criteria need a model that is not
    set up."""

    async def work(progress: Progress) -> dict:
        tone.save_policy(payload.name, payload.text)
        return {'ok': True}

    try:
        return await jobs.perform('tone-policy', work)
    except BusyError as error:
        raise HTTPException(409, str(error)) from error
    except ValueError as error:
        raise HTTPException(400, str(error)) from error


@router.post('/api/tone-of-voice/copy')
async def copy_tone_rules(jobs: Jobs, payload: ToneCopyCommand) -> dict:
    """The rules of communication of another agent (`agent`) and their criteria, with the clarifications people
    confirmed, become this agent's own as a copy: later changes in either never reach the other (tone.take). The
    marks of serious errors come with the criteria. `unchanged` when this agent had the same rules, criteria and marks
    already."""
    try:
        _, found, marks, proposed = tone.copied_from(payload.agent)
    except LookupError as error:
        raise HTTPException(404, str(error)) from error
    except ValueError as error:
        raise HTTPException(400, str(error)) from error
    try:
        return await jobs.perform('tone-policy', lambda progress: _copied(found, marks, proposed))
    except BusyError as error:
        raise HTTPException(409, str(error)) from error


async def _copied(found: tuple[dict, dict | None], marks: dict[str, bool], proposed: dict) -> dict:
    return tone.copy(found, marks, proposed)


@router.post('/api/tone-of-voice/read-file')
async def read_tone_file(request: Request, name: str) -> dict:
    data = await uploaded(request, policy_files.LIMIT, 'Оставьте в файле только правила общения.')
    try:
        text = await asyncio.to_thread(policy_files.read, name, data)
    except ValueError as error:
        raise HTTPException(400, str(error)) from error
    return {'text': text, 'name': name}


@router.post('/api/tone-of-voice/criteria')
async def prepare_tone_criteria(jobs: Jobs) -> dict:
    """«Собрать критерии»: refused before it starts when the rules need a model that is not set up."""
    try:
        tone.ensure_collectable(tone.current_policy())
    except ValueError as error:
        raise HTTPException(400, str(error)) from error
    return work.start(jobs, 'tone-criteria', {})


@router.post('/api/tone-of-voice/check')
async def check_tone(jobs: Jobs, payload: ToneCheckCommand) -> dict:
    try:
        tone.selection(payload.ruleIds, payload.revision)
    except ValueError as error:
        raise HTTPException(400, str(error)) from error
    revision = storage.documents.load(tone.DRAFT)['revision']
    given = {'ruleIds': payload.ruleIds, 'revision': revision, 'count': payload.count, 'propose': payload.propose}
    return work.start(jobs, 'tone-check', given)


@router.post('/api/tone-of-voice/kinds')
async def group_tone_kinds(jobs: Jobs) -> dict:
    """«Сгруппировать ошибки»: the model groups the errors of each criterion of the current result by the mistake
    (flows.kinds), for a result checked before checks grouped them; refused before it starts without models."""
    try:
        models.ensure_set_up()
    except ValueError as error:
        raise HTTPException(400, str(error)) from error
    return work.start(jobs, 'tone-kinds', {})


@router.get('/api/tone-of-voice/history')
def tone_history() -> dict:
    result = storage.documents.load(tone.RESULT) or {}
    return {
        'checks': storage.history.lines(checks.TONE),
        'hasLegacyResult': result.get('purpose') == checks.TONE_OF_VOICE and not result.get('checkId'),
    }


@router.get('/api/tone-of-voice/history/{check_id}')
def tone_history_detail(check_id: str) -> dict:
    return saved(checks.TONE, check_id)


@router.post('/api/tone-of-voice/advice')
async def tone_advice_command(jobs: Jobs, payload: ToneAdviceCommand) -> dict:
    return await _proposed(jobs, lambda: advice.suggest(payload.finishedAt, payload.dialogueId, payload.ruleId))


@router.post('/api/tone-of-voice/clarification/proposal')
async def tone_clarification_proposal(jobs: Jobs, payload: ToneClarifyCommand) -> dict:
    return await _proposed(jobs, lambda: advice.clarify(payload.finishedAt, payload.ruleId, payload.note))


async def _proposed(jobs: Jobs, propose: Callable[[], Awaitable[dict]]) -> dict:
    """A model's suggestion as one job: refused while other work runs, nothing kept when it is stopped."""

    async def work(progress: Progress) -> dict:
        progress(message='Готовим предложение')
        return await propose()

    try:
        return await jobs.perform('tone-advice', work)
    except BusyError as error:
        raise HTTPException(409, str(error)) from error
    except asyncio.CancelledError as error:
        raise HTTPException(409, 'Подготовка предложения остановлена') from error
    except ValueError as error:
        raise HTTPException(400, str(error)) from error
    except models.ModelError as error:
        raise HTTPException(502, str(error)) from error


@router.post('/api/tone-of-voice/clarification')
async def tone_clarification(jobs: Jobs, payload: ToneClarificationCommand) -> dict:
    async def work(progress: Progress) -> dict:
        return tone.clarify(payload.revision, payload.ruleId, payload.text)

    try:
        return await jobs.perform('tone-clarification', work)
    except BusyError as error:
        raise HTTPException(409, str(error)) from error
    except ValueError as error:
        raise HTTPException(400, str(error)) from error
