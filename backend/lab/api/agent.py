"""The agent under test, the section «Агент»: the settings it is reached by, a check of the connection, reading its
code (its prompts and tools), the text of a source and the knowledge-base articles it reads."""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from ..agents import knowledge
from ..flows import connection, inputs
from .base import Jobs, start

router = APIRouter()


class ClientCommand(BaseModel):
    """The organization of one EPK id: what the synthetic customer can name on the IFT stand."""

    name: str = ''
    inn: str = ''
    terminals: list[str] | str = Field(default_factory=list)


class SettingsCommand(BaseModel):
    prodUrl: str = ''
    epk: list[str] | str = Field(default_factory=list)
    clients: dict[str, ClientCommand] = Field(default_factory=dict)
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
    return start(jobs, 'sources', lambda progress: inputs.read_code())


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
