"""«Повтор разговоров»: the exported conversations replayed through an agent that gives its trace, each step judged,
and the latest replay with what it says about the knowledge base."""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from ..flows import connection, replay
from . import work
from .base import Jobs

router = APIRouter()


class ReplayCommand(BaseModel):
    target: str
    count: int = Field(default=10, ge=1, le=200)


@router.post('/api/replay')
async def start_replay(jobs: Jobs, payload: ReplayCommand) -> dict:
    if payload.target not in connection.replay_ways():
        raise HTTPException(400, connection.UNKNOWN_WAY)
    return work.start(jobs, 'replay', payload.model_dump())


@router.get('/api/replay')
def replay_result() -> dict:
    """The latest replay and what it says about the knowledge base, counted on every read from the saved verdicts."""
    return replay.shown()
