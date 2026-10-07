"""The export of real conversations: uploading it, and one conversation with its evaluation."""

import asyncio
from typing import Literal

from fastapi import APIRouter, HTTPException, Request

from ..domain import export
from ..flows import checks as results_of
from ..flows import inputs
from ..jobs import BusyError
from .base import Jobs, uploaded

router = APIRouter()


@router.post('/api/logs')
async def upload_logs(jobs: Jobs, request: Request, name: str) -> dict:
    data = await uploaded(request, export.LIMIT, 'Выгрузите разговоры за меньший срок.')
    try:
        return await jobs.perform('logs', lambda progress: inputs.upload_export(name, data))
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
