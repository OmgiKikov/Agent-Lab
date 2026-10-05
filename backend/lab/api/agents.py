"""The agents the Lab checks: the list, each with its checks' results and its rules of communication, and a new agent.
Each agent's data is in its own database (storage.registry)."""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from ..domain import checks
from ..flows import checks as results_of
from ..flows import tone
from ..storage import registry

router = APIRouter()


class AgentCommand(BaseModel):
    name: str = Field(max_length=80)
    description: str = Field(default='', max_length=200)


@router.get('/api/agents')
def agents_view() -> list[dict]:
    """Every agent with the result of each of its checks and its rules of communication, read from its own database.
    Never ranked: the agents have other dialogues and other rules; nor are an agent's two checks added up."""
    listed = []
    for agent in registry.listed():
        with registry.using(agent['id']):
            lines = {check: results_of.line(check) for check in checks.RESULTS}
            listed.append({**agent, 'results': lines, 'rules': tone.rules_line()})
    return listed


@router.post('/api/agents')
def create_agent(payload: AgentCommand) -> dict:
    try:
        return registry.create(payload.name, payload.description)
    except ValueError as error:
        raise HTTPException(400, str(error)) from error
