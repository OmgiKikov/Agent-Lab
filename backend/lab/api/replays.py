"""The live agent on the same customers: a check of it started on the customers of a check's result, and one check with
its conversations."""

from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from .. import storage
from ..flows import connection, replay
from . import work
from .base import Jobs

router = APIRouter()


class ReplayCommand(BaseModel):
    check: Literal['tone', 'code']
    target: str
    count: int = Field(default=50, ge=1, le=300)


@router.post('/api/replays')
async def start_replay(jobs: Jobs, payload: ReplayCommand) -> dict:
    if payload.target not in connection.ways():
        raise HTTPException(400, connection.UNKNOWN_WAY)
    try:
        replay.ready(payload.check)
    except ValueError as error:
        raise HTTPException(400, str(error)) from error
    return work.start(jobs, 'replay', payload.model_dump(), task_id=replay.new_id())


@router.get('/api/replays/{replay_id}')
def replay_detail(replay_id: str) -> dict:
    """A check of the live agent with its conversations: the recorded and the played ones, with their verdicts."""
    record = storage.replays.get(replay_id)
    if record is None:
        raise HTTPException(404, 'Проверка живого агента не найдена')
    return record
