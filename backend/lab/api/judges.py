"""Named judge rule sets, immutable versions, manual criteria and actual rule exports."""

from typing import Literal

from fastapi import APIRouter, HTTPException
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel, Field

from ..flows import judges
from ..jobs import BusyError
from .base import Jobs

router = APIRouter()
Kind = Literal['tone', 'code']


class Criterion(BaseModel):
    id: str = Field(min_length=1, max_length=100)
    name: str = Field(min_length=1, max_length=200)
    text: str = Field(min_length=1, max_length=50000)
    condition: str = Field(default='', max_length=5000)
    acceptable: str = Field(default='', max_length=5000)
    quote: str = Field(default='', max_length=50000)
    sourceId: str = ''
    clarifications: list[str] = Field(default_factory=list, max_length=20)
    observation: str = 'reply'


class SaveRules(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    policy: str = Field(min_length=20, max_length=50000)
    criteria: list[Criterion] = Field(min_length=1, max_length=100)
    setId: str | None = None
    baseId: str | None = None


class SelectRules(BaseModel):
    id: str | None = None


@router.get('/api/judges/{kind}')
def library(kind: Kind) -> dict:
    return judges.library(kind)


@router.post('/api/judges/{kind}')
async def save(kind: Kind, jobs: Jobs, payload: SaveRules) -> dict:
    async def work(progress: object) -> dict:
        return judges.save(
            kind,
            payload.name,
            payload.policy,
            [c.model_dump() for c in payload.criteria],
            payload.setId,
            payload.baseId,
        )

    try:
        return await jobs.perform('judge-rules', work)
    except BusyError as error:
        raise HTTPException(409, str(error)) from error
    except ValueError as error:
        raise HTTPException(400, str(error)) from error


@router.post('/api/judges/{kind}/select')
async def select(kind: Kind, jobs: Jobs, payload: SelectRules) -> dict:
    async def work(progress: object) -> dict:
        return judges.activate(kind, payload.id)

    try:
        return await jobs.perform('judge-rules', work)
    except BusyError as error:
        raise HTTPException(409, str(error)) from error
    except ValueError as error:
        raise HTTPException(400, str(error)) from error


@router.get('/api/judge-versions/{version_id}/download')
def download(version_id: str) -> PlainTextResponse:
    try:
        return PlainTextResponse(judges.markdown(version_id), media_type='text/markdown; charset=utf-8')
    except ValueError as error:
        raise HTTPException(404, str(error)) from error


@router.get('/api/judges/{kind}/export')
def export_current(kind: Kind) -> PlainTextResponse:
    try:
        return PlainTextResponse(judges.current_markdown(kind), media_type='text/markdown; charset=utf-8')
    except ValueError as error:
        raise HTTPException(400, str(error)) from error
