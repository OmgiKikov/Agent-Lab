"""One conversation of an export with its evaluation, and the earlier address of an upload."""

from typing import Literal

from fastapi import APIRouter, HTTPException, Request

from ..flows import checks as results_of
from .base import Jobs
from .exports import receive

router = APIRouter()


@router.post('/api/logs')
async def upload_logs(jobs: Jobs, request: Request, name: str) -> dict:
    """An export uploaded the earlier way: added beside the others, as POST /api/exports does."""
    return await receive(jobs, request, name, None)


@router.get('/api/logs/{dialogue_id}')
def log_detail(dialogue_id: str, check: Literal['tone', 'code'] | None = None) -> dict:
    """A logged conversation with its evaluation in the result of the check asked for; without one, in tone of voice's
    result, then in Точность's."""
    found = results_of.conversation(dialogue_id, check)
    if found is None:
        raise HTTPException(404, 'Разговор не найден')
    return found
