"""The catalog of business scenarios: building it from the export, and reading it."""

from fastapi import APIRouter, Body, HTTPException
from pydantic import BaseModel

from ..flows import catalog
from .base import Jobs, start

router = APIRouter()


class CatalogCommand(BaseModel):
    rebuild: bool = False


@router.post('/api/catalog')
async def start_catalog(jobs: Jobs, payload: CatalogCommand | None = Body(default=None)) -> dict:
    """The catalog brought up to date: new conversations read and placed; rebuild proposes its scenarios anew."""
    rebuild = bool(payload and payload.rebuild)
    return start(jobs, 'catalog', lambda progress: catalog.build(progress, rebuild=rebuild))


@router.get('/api/catalog')
def catalog_view() -> dict:
    """The categories and scenarios with their counts, shares and examples, and the totals of the export; the reading
    of each conversation stays on the server."""
    found = catalog.current()
    if not found or not found.get('categories'):
        raise HTTPException(404, 'Каталог бизнес-сценариев ещё не собран')
    return {key: value for key, value in found.items() if key not in ('episodes', 'proposed')}
