"""The two checks of the real conversations as the screens read them: a check of Точность, the current result of
either check with its verdicts, its rules and problems (also in a run), «было → стало» and the history of saved
checks."""

from typing import Literal

from fastapi import APIRouter, Body, HTTPException
from pydantic import BaseModel, Field

from .. import storage
from ..domain import checks
from ..flows import accuracy
from ..flows import checks as results_of
from .base import Jobs, start

router = APIRouter()
Check = Literal['tone', 'code']


class DiscoverCommand(BaseModel):
    count: int = Field(default=60, ge=5, le=300)
    replan: bool = False
    # After the check the model proposes which errors are serious (severity.propose); the screens ask for it.
    propose: bool = False


@router.post('/api/discover')
async def start_discover(jobs: Jobs, payload: DiscoverCommand | None = Body(default=None)) -> dict:
    payload = payload or DiscoverCommand()
    return start(
        jobs,
        'discover',
        lambda progress: accuracy.check(payload.count, progress, replan=payload.replan, propose=payload.propose),
    )


@router.get('/api/checks/{check}')
def result_view(check: Check) -> dict:
    """The check's current result with the verdicts on every conversation and the answers people gave on them;
    /api/state gives it in brief, and the screens fetch this by its checkId and reviewsStamp."""
    found = results_of.shown(check)
    if found is None:
        raise HTTPException(404, f'У проверки «{checks.NAMES[check]}» ещё нет итога.')
    return found


@router.get('/api/problems')
def problems_view(check: Check = checks.TONE, run: str | None = None) -> dict:
    """Every rule of one check with its verdicts in the logs and in one run of that check; the rules found violated
    are the problems. A run is measured by its own check's criteria, so its check is taken; without either, tone of
    voice (older links)."""
    if run:
        record = storage.runs.get(run)
        if record is None:
            raise HTTPException(404, 'Прогон не найден')
        check = checks.of_run(record)
    return results_of.problems(check, run)


@router.get('/api/compare')
def compare_view(check: Check = checks.TONE) -> dict:
    """«Было → стало»: the check's current result against its previous saved check, criterion by criterion, when both
    have the same criteria and models; otherwise only how they stand to each other. Reads saved records only."""
    return results_of.comparison(check)


@router.get('/api/history/{check}')
def history_view(check: Check) -> dict:
    """The saved checks of one check, the newest first, each with how it stands to the one saved before it."""
    return {'checks': results_of.saved_checks(check)}


@router.get('/api/history/{check}/{check_id}')
def history_detail(check: Check, check_id: str) -> dict:
    """A saved check with its evidence and the answers given on it: tone of voice's as /api/tone-of-voice/history/{id};
    Точность's with its result and the conversations it judged."""
    return saved(check, check_id)


def saved(check: str, check_id: str) -> dict:
    found = results_of.with_reviews(check, check_id)
    if found is None:
        raise HTTPException(404, 'Проверка не найдена')
    return found
