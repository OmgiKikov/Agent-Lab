"""A reviewable configuration starts one durable launch with independently reported modes."""

from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from .. import storage
from ..flows import launches
from . import work
from .base import Jobs

router = APIRouter()


class LaunchCommand(BaseModel):
    check: Literal['tone', 'code']
    datasetId: str = Field(min_length=1)
    judgeId: str | None = None
    agentVersion: str = Field(default='', max_length=80)
    count: int = Field(default=100, ge=1, le=300)
    modes: list[Literal['dataset', 'questions', 'simulations']] = Field(min_length=1, max_length=3)
    target: str = 'prod'


@router.post('/api/launches')
async def launch(jobs: Jobs, payload: LaunchCommand) -> dict:
    if jobs.state['running']:
        raise HTTPException(409, 'Дождитесь текущей задачи или остановите её.')
    try:
        given = launches.prepare(payload.model_dump())
    except ValueError as error:
        raise HTTPException(400, str(error)) from error
    result = work.start(jobs, 'launch', given)
    task = storage.tasks.latest('launch')
    return {**result, 'id': task['id']}


@router.get('/api/launches')
def history(check: Literal['tone', 'code'] | None = None) -> dict:
    return {'launches': [r for r in storage.launches.listed('launch') if check is None or r['check'] == check]}


@router.get('/api/launches/{launch_id}')
def result(launch_id: str) -> dict:
    found = storage.launches.get('launch', launch_id)
    if found is None:
        task = storage.tasks.get(launch_id)
        if task and task['kind'] == 'launch':
            return {
                'id': launch_id,
                'check': task['input']['check'],
                'status': task['status'],
                'modes': {},
                'startedAt': task['startedAt'],
                'error': task['error'],
            }
        raise HTTPException(404, 'Запуск не найден.')
    return found


@router.post('/api/launches/{launch_id}/retry')
async def retry(launch_id: str, jobs: Jobs) -> dict:
    record = storage.launches.get('launch', launch_id)
    if record is None:
        raise HTTPException(404, 'Запуск не найден.')
    return await launch(jobs, LaunchCommand(**record['inputs']))


@router.get('/api/questions/{run_id}')
def questions_result(run_id: str) -> dict:
    record = storage.launches.get('questions', run_id)
    if record is None:
        raise HTTPException(404, 'Ответы агента не найдены.')
    return record
