"""The catalog of business scenarios: building it from the export, and reading it; the profile of the agent it is
built for."""

from fastapi import APIRouter, Body, HTTPException
from pydantic import BaseModel

from ..flows import catalog, profile
from . import work
from .base import Jobs

router = APIRouter()


class CatalogCommand(BaseModel):
    rebuild: bool = False


@router.post('/api/catalog')
async def start_catalog(jobs: Jobs, payload: CatalogCommand | None = Body(default=None)) -> dict:
    """The catalog brought up to date: new conversations read and placed; rebuild proposes its scenarios anew."""
    rebuild = bool(payload and payload.rebuild)
    return work.start(jobs, 'catalog', {'rebuild': rebuild})


@router.get('/api/catalog')
def catalog_view() -> dict:
    """The categories and scenarios with their counts, shares and examples, and the totals of the export; the reading
    of each conversation stays on the server."""
    found = catalog.current()
    if not found or not found.get('categories'):
        raise HTTPException(404, 'Каталог бизнес-сценариев ещё не собран')
    return {key: value for key, value in found.items() if key not in ('episodes', 'proposed')}


@router.get('/api/profile')
def profile_view() -> dict:
    """The profile of the agent under test: its domain, the identifiers of its customers, how the export names it."""
    try:
        return profile.current()
    except RuntimeError as error:
        raise HTTPException(404, str(error)) from error


@router.post('/api/profile')
def save_profile(jobs: Jobs, payload: dict = Body(...)) -> dict:
    """A person's profile of the agent; the conversations are read again under it on the next build."""
    if jobs.state['running']:
        raise HTTPException(409, 'Профиль нельзя менять, пока идёт задача. Дождитесь её или остановите.')
    try:
        return profile.save(payload)
    except ValueError as error:
        raise HTTPException(400, str(error)) from error
