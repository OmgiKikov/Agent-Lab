"""Judging a conversation the synthetic customer had with the agent: the evidence both judges see, prepared once, and
their verdicts written into the run's conversation (roles.judge asks the models; domain.verdicts says what a verdict
stands on)."""

import asyncio

from . import models
from .context import knowledge
from .roles import judge
from .transcript import for_judge, tool_calls


async def evidence(card: dict, conversation: list[dict]) -> judge.Evidence:
    """What both judges see of a played conversation, with the knowledge articles the agent read in it."""
    shown = [{'role': m['role'].upper(), 'text': for_judge(m)} for m in conversation]
    agents = [message for message in conversation if message['role'] == 'agent']
    # The agent's words and its buttons' labels: the agent wrote both, the Lab's «[Кнопки: …]» around them it did not.
    agent_text = '\n'.join(line for message in agents for line in (message['text'], *(message.get('options') or [])))
    calls = '\n'.join(call for message in agents for call in tool_calls(message))
    retrieved = await asyncio.to_thread(knowledge.retrieved, conversation)
    payload = {
        'expectations': card['criteria'],
        'conversation': shown,
        'toolCallsObserved': bool(calls),
        'knowledge': retrieved,
    }
    return judge.Evidence(card['criteria'], payload, agent_text, calls, bool(retrieved))


async def run_verdict(card: dict, conversation: list[dict], model: models.Endpoint | None = None) -> judge.Verdict:
    """A conversation the synthetic customer just had with the agent, against the card's criteria."""
    return await judge.run_verdict(await evidence(card, conversation), model)


async def evaluate(card: dict, item: dict) -> None:
    """Judge a run's conversation in place: rows, verdict and the second judge's verdict."""
    prepared = await evidence(card, item['conversation'])
    try:
        async with asyncio.TaskGroup() as tasks:
            primary = tasks.create_task(judge.run_verdict(prepared))
            secondary = tasks.create_task(judge.second_opinion(judge.run_verdict, prepared))
    except* models.ModelError as errors:
        raise models.ModelError(str(errors.exceptions[0])) from errors
    result = primary.result()
    item.update(rules=result.rows, status=result.status, model=result.model, judgeVersion=result.version)
    item['second'] = secondary.result()
