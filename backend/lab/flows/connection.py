"""The agent under test as the person set it up on the page «Агент»: its address on the IFT stand, the customers to talk
as, the folder of its code; and the ways to reach it by those settings (agents.configs)."""

import uuid
from pathlib import Path

from .. import agents, storage
from . import agent_context

SETTINGS = 'settings.json'
CHECK_QUESTION = 'Какой процент эквайринга?'  # what «Проверить связь» asks the agent
UNKNOWN_WAY = 'Неизвестный способ подключения агента.'  # a way the service does not have (agents.configs)


def settings() -> dict:
    return agents.settings(storage.documents.load(SETTINGS, {}) or {})


def save_settings(values: dict) -> dict:
    """The person's changes to the settings; a typo in the agent's address is refused (ValueError)."""
    storage.documents.save(SETTINGS, agents.changed(settings(), values))
    return settings()


def repo() -> Path:
    """The folder of the agent's code."""
    return agent_context.checkout_path() or Path(settings()['repo']).expanduser()


def ways() -> dict[str, dict]:
    """The ways to reach the agent, by its settings."""
    return agents.configs(settings() | {'repo': str(repo())})


def connect(key: str) -> agents.HttpAgent:
    """The agent reached this way; one started from its code writes its output beside the agent's database."""
    connection = ways().get(key)
    if not connection:
        raise agents.AgentError(f'Неизвестный способ подключения агента: {key}.')
    folder = storage.db.database().parent
    storage.db.private_folder(folder)
    return agents.create(connection | {'log': folder / agents.code.LOG})


async def check(key: str) -> dict:
    """«Проверить связь»: one question to the agent and its answer, or why there is none. An agent started from its
    code lives only for a run: its connection cannot be checked ahead (ValueError)."""
    agent = connect(key)
    if isinstance(agent, agents.CodeAgent):
        raise ValueError('Агент из кода запускается только на время прогона, поэтому связь заранее не проверить.')
    try:
        async with agents.session(agent):
            reply = await agent.say(str(uuid.uuid4()), CHECK_QUESTION)
        return {'ok': True, 'question': CHECK_QUESTION, 'version': agent.version, **reply}
    except agents.AgentError as error:
        return {'ok': False, 'error': str(error)}
