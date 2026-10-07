"""The deck of scenarios: building it for the criteria of one check, and each scenario as a test with its results."""

from typing import Literal

from fastapi import APIRouter, Body, HTTPException
from pydantic import BaseModel

from ..flows import scenarios
from .base import Jobs, start

router = APIRouter()


class CardsCommand(BaseModel):
    check: Literal['tone', 'code'] | None = None


@router.post('/api/cards')
async def start_cards(jobs: Jobs, payload: CardsCommand | None = Body(default=None)) -> dict:
    """Scenarios judged by the criteria of one check: the one asked for, else the only check with a result."""
    try:
        check = scenarios.chosen_check(payload.check if payload else None)
    except ValueError as error:
        raise HTTPException(400, str(error)) from error
    return start(jobs, 'cards', lambda progress: scenarios.build(check, progress))


@router.get('/api/scenarios')
def scenarios_view() -> dict:
    """Each scenario of the deck as a test: its own result in every run of the deck's check, newest first. Results of
    runs stand side by side; nothing compares them."""
    return scenarios.listed()
