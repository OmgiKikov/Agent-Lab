"""The export of real conversations: uploading it, and one conversation with its evaluation."""

import asyncio
from typing import Literal

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, Field

from ..domain import export
from ..flows import checks as results_of
from ..flows import datasets, inputs
from ..jobs import BusyError
from .base import Jobs, uploaded

router = APIRouter()


@router.get('/api/logs')
def log_page(offset: int = Query(0, ge=0), limit: int = Query(20, ge=1, le=50)) -> dict:
    """Browse uploaded conversations without starting a check or calling a model."""
    return inputs.export_page(offset, limit)


@router.post('/api/logs')
async def upload_logs(
    jobs: Jobs, request: Request, name: str, title: str | None = None, agentVersion: str | None = None
) -> dict:
    """A dataset uploaded: the file (name), what to call it (title) and the version of the agent whose answers it
    holds (agentVersion), both by choice."""
    data = await uploaded(request, export.LIMIT, 'Выгрузите разговоры за меньший срок.')
    try:
        return await jobs.perform('logs', lambda progress: inputs.upload_export(name, data, title, agentVersion))
    except BusyError as error:
        raise HTTPException(409, str(error)) from error
    except asyncio.CancelledError as error:
        raise HTTPException(409, 'Загрузка остановлена') from error
    except (ValueError, KeyError, OSError) as error:
        raise HTTPException(400, f'Не удалось прочитать файл. {error}') from error


@router.get('/api/logs/{dialogue_id}')
def log_detail(dialogue_id: str, check: Literal['tone', 'code'] | None = None) -> dict:
    """A logged conversation with its evaluation in the result of the check asked for; without one, in tone of voice's
    result, then in Точность's."""
    found = results_of.conversation(dialogue_id, check)
    if found is None:
        raise HTTPException(404, 'Разговор не найден')
    return found


class DatasetCommand(BaseModel):
    id: str = Field(min_length=1, max_length=120)
    name: str | None = Field(None, min_length=1, max_length=160)
    # The version of the agent whose answers the dataset holds: the flow trims it and refuses one too long in words.
    agentVersion: str | None = None
    undo: bool = False


@router.get('/api/datasets')
def datasets_view(archived: bool = False) -> dict:
    return datasets.listed(archived=archived)


@router.get('/api/datasets/{dataset_id}/dialogues')
def dataset_dialogues(dataset_id: str, offset: int = Query(0, ge=0), limit: int = Query(20, ge=1, le=50)) -> dict:
    """Browse any dataset's conversations without making it the one the checks go by."""
    found = datasets.dialogues(dataset_id, offset, limit)
    if found is None:
        raise HTTPException(404, 'Датасет не найден')
    return found


@router.get('/api/datasets/{dataset_id}/dialogues/{dialogue_id}')
def dataset_dialogue(dataset_id: str, dialogue_id: str) -> dict:
    found = datasets.dialogue(dataset_id, dialogue_id)
    if found is None:
        raise HTTPException(404, 'Разговор не найден')
    return found


@router.post('/api/datasets/{action}')
async def dataset_action(
    action: Literal['select', 'archive', 'rename', 'version'], jobs: Jobs, payload: DatasetCommand
) -> dict:
    async def work(progress: object) -> dict:
        if action == 'select':
            return datasets.select(payload.id)
        if action == 'archive':
            return datasets.archive(payload.id, undo=payload.undo)
        if action == 'version':
            return datasets.set_version(payload.id, payload.agentVersion)
        return datasets.rename(payload.id, payload.name or '')

    try:
        return await jobs.perform('datasets', work)
    except BusyError as error:
        raise HTTPException(409, str(error)) from error
    except ValueError as error:
        raise HTTPException(400, str(error)) from error
