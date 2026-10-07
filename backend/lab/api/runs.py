"""Runs: the deck's scenarios played against the agent, one run with its conversations, and a run judged again."""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from .. import storage
from ..domain import personas
from ..flows import connection, simulation
from . import work
from .base import Jobs

router = APIRouter()


class RunCommand(BaseModel):
    target: str
    label: str = ''
    repeats: int = Field(default=1, ge=1, le=3)
    personas: list[str] = Field(default_factory=list)
    cardIds: list[str] | None = None


@router.post('/api/runs')
async def start_run(jobs: Jobs, payload: RunCommand) -> dict:
    if payload.target not in connection.ways():
        raise HTTPException(400, connection.UNKNOWN_WAY)
    chosen = [key for key in payload.personas if key in personas.PERSONAS] or [personas.DEFAULT]
    given = payload.model_dump() | {'cardIds': payload.cardIds or None, 'personas': chosen}
    return work.start(jobs, 'run', given, task_id=simulation.new_run_id())


@router.get('/api/runs/{run_id}')
def run_detail(run_id: str) -> dict:
    """A run with its conversations and the answers people gave on them."""
    record = storage.runs.get(run_id)
    if record is None:
        raise HTTPException(404, 'Прогон не найден')
    return record


@router.post('/api/runs/{run_id}/rejudge')
async def rejudge(jobs: Jobs, run_id: str) -> dict:
    record = storage.runs.get(run_id)
    if record is None:
        raise HTTPException(404, 'Прогон не найден')
    return work.start(jobs, 'rejudge', {'runId': run_id})
