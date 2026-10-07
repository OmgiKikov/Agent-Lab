"""The agent under test, the section «Агент»: the settings it is reached by, a check of the connection, reading its
code (its prompts and tools), the text of a source and the knowledge-base articles it reads."""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from ..agents import knowledge
from ..flows import agent_context, connection, inputs
from ..jobs import BusyError
from . import work
from .base import Jobs

router = APIRouter()


class SettingsCommand(BaseModel):
    prodUrl: str = ''
    epk: list[str] | str = Field(default_factory=list)
    repo: str = ''


@router.post('/api/settings')
async def save_settings(jobs: Jobs, payload: SettingsCommand) -> dict:
    if jobs.state['running']:
        raise HTTPException(409, 'Настройки нельзя менять, пока идёт задача. Дождитесь её или остановите.')
    try:
        return connection.save_settings(payload.model_dump(exclude_unset=True))
    except ValueError as error:
        raise HTTPException(400, str(error)) from error


@router.post('/api/agents/{key}/check')
async def check_agent(key: str) -> dict:
    if key not in connection.ways():
        raise HTTPException(404, connection.UNKNOWN_WAY)
    try:
        return await connection.check(key)
    except ValueError as error:
        raise HTTPException(400, str(error)) from error


@router.post('/api/sources')
async def collect_sources(jobs: Jobs) -> dict:
    return work.start(jobs, 'sources', {})


@router.get('/api/sources/{source_id}')
def source_view(source_id: str) -> dict:
    """The text of a source the rules are quoted from: a prompt or the list of the agent's tools."""
    found = next((source for source in inputs.sources() if source['id'] == source_id), None)
    if found is None:
        raise HTTPException(404, 'Источник не найден')
    return {key: found.get(key) for key in ('id', 'kind', 'origin', 'sha256', 'content')}


@router.get('/api/articles/{article_id}')
def article_view(article_id: str) -> dict:
    """A knowledge-base article the agent read during a simulated turn: its title and text."""
    found = knowledge.article(connection.repo(), article_id)
    if found is None:
        raise HTTPException(404, 'Статьи нет в базе знаний агента')
    return found


class ContextCommand(BaseModel):
    tools: list[str] = Field(default_factory=list, max_length=100)
    idpUrl: str = Field(default='', max_length=2000)
    idpIndex: str = Field(default='', max_length=200)
    idpEmbedder: str = Field(default='', max_length=200)
    idpFilter: str = Field(default='', max_length=500)
    repositoryUrl: str = Field(default='', max_length=2000)


@router.get('/api/agent/context')
def context_view() -> dict:
    return agent_context.current()


@router.post('/api/agent/context')
async def context_save(jobs: Jobs, payload: ContextCommand) -> dict:
    async def work(progress: object) -> dict:
        return agent_context.save(payload.model_dump())

    try:
        return await jobs.perform('agent-context', work)
    except BusyError as error:
        raise HTTPException(409, str(error)) from error
    except ValueError as error:
        raise HTTPException(400, str(error)) from error


@router.post('/api/agent/idp/check')
async def check_idp() -> dict:
    articles, error = await agent_context.knowledge('Проверка доступности базы знаний')
    if not agent_context.current()['idpIndex']:
        return {'ok': False, 'error': 'Укажите индекс IDP.'}
    return {'ok': error is None, 'error': error, 'sources': len(articles)}
