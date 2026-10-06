"""The exports of real conversations: uploading one, the list with the checks made of each, renaming, removing, and an
export's conversations."""

import asyncio
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, StringConstraints

from .. import storage
from ..domain import export
from ..flows import Progress, exports, inputs
from ..jobs import BusyError
from .base import Jobs, uploaded

router = APIRouter()


# A name is what is left of it without the spaces around: one of spaces only names nothing.
Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=120)]


class RenameCommand(BaseModel):
    name: Name


async def receive(jobs: Jobs, request: Request, name: str, title: str | None) -> dict:
    """An uploaded export added beside the others, under its title (the file's name by default): its line."""
    data = await uploaded(request, export.LIMIT, 'Выгрузите разговоры за меньший срок.')
    try:
        return await jobs.perform('logs', lambda progress: inputs.upload_export(name, data, title))
    except BusyError as error:
        raise HTTPException(409, str(error)) from error
    except asyncio.CancelledError as error:
        raise HTTPException(409, 'Загрузка остановлена') from error
    except (ValueError, KeyError, OSError) as error:
        raise HTTPException(400, f'Не удалось прочитать файл. {error}') from error


@router.get('/api/exports')
def exports_list() -> dict:
    return {'exports': exports.listed()}


@router.post('/api/exports')
async def upload_export(
    jobs: Jobs, request: Request, name: str, title: Annotated[str | None, Query(max_length=120)] = None
) -> dict:
    return await receive(jobs, request, name, title)


@router.post('/api/exports/{export_id}/rename')
def rename_export(export_id: str, payload: RenameCommand) -> dict:
    found = storage.exports.rename(export_id, payload.name)
    if found is None:
        raise HTTPException(404, 'Выгрузки уже нет.')
    return found


@router.post('/api/exports/{export_id}/delete')
async def delete_export(jobs: Jobs, export_id: str) -> dict:
    """The export removed while no other task of the agent runs: its conversations, the current result made of it and
    the scenarios built from that go together."""

    async def work(progress: Progress) -> dict:
        return exports.remove(export_id)

    try:
        return await jobs.perform('exports', work)
    except BusyError as error:
        raise HTTPException(409, str(error)) from error
    except LookupError as error:
        raise HTTPException(404, str(error)) from error


@router.get('/api/exports/{export_id}/conversations')
def export_conversations(export_id: str, offset: int = 0, limit: int = exports.PAGE) -> dict:
    found = exports.page(export_id, max(0, offset), min(max(1, limit), 200))
    if found is None:
        raise HTTPException(404, 'Выгрузки уже нет.')
    return found


@router.get('/api/exports/{export_id}/conversations/{dialogue_id}')
def export_conversation(export_id: str, dialogue_id: str) -> dict:
    found = storage.exports.conversation(export_id, dialogue_id)
    if found is None:
        raise HTTPException(404, 'Разговор не найден')
    return found
