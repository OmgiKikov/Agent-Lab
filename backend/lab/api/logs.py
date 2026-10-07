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
async def upload_logs(jobs: Jobs, request: Request, name: str, title: str | None = None) -> dict:
    data = await uploaded(request, export.LIMIT, 'Выгрузите разговоры за меньший срок.')
    try:
        return await jobs.perform('logs', lambda progress: inputs.upload_export(name, data, title))
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
    undo: bool = False


@router.get('/api/datasets')
def datasets_view(archived: bool = False) -> dict:
    return datasets.listed(archived=archived)


@router.post('/api/datasets/{action}')
async def dataset_action(action: Literal['select', 'archive', 'rename'], jobs: Jobs, payload: DatasetCommand) -> dict:
    async def work(progress: object) -> dict:
        if action == 'select':
            return datasets.select(payload.id)
        if action == 'archive':
            return datasets.archive(payload.id, undo=payload.undo)
        return datasets.rename(payload.id, payload.name or '')

    try:
        return await jobs.perform('datasets', work)
    except BusyError as error:
        raise HTTPException(409, str(error)) from error
    except ValueError as error:
        raise HTTPException(400, str(error)) from error
