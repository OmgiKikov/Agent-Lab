"""The agent started from its repository (local/run-app.sh) on its own port for the time of one run."""

import asyncio
import os
import signal
import socket
import subprocess
import time
from pathlib import Path

import httpx

from .. import store
from .http import AGENT_PATH, AgentError, HttpAgent

LOG = 'local-code-agent.log'  # beside the database of the agent being checked: agents run in parallel (jobs.PerAgent)
START = 'local/run-app.sh'  # in the agent's folder: what starts it
START_TIMEOUT = 180
# Ports chosen by this process for agents it has not stopped yet: two runs starting at once must not both pick a port
# their processes have not bound yet.
_HELD: set[int] = set()
# The Lab's own keys stay with the Lab: the agent's code, and every log it writes, never holds the means to spend the
# Lab's models (the model keys, the Pi bridges' token) or to call the bank's gateway as the Lab.
PRIVATE = ('LAB_MODEL_KEY', 'LAB_SECOND_KEY', 'PI_PROXY_TOKEN')
PRIVATE_PREFIX = 'AGENT_LAB_GATEWAY_'


def environment(port: int) -> dict[str, str]:
    """What the agent's process starts with: the Lab's environment without its keys, and the port to listen on."""
    kept = {
        name: value for name, value in os.environ.items() if name not in PRIVATE and not name.startswith(PRIVATE_PREFIX)
    }
    return {**kept, 'APP_PORT': str(port)}


def free_port(preferred: int) -> int:
    """The preferred port if nobody listens on it and no other run holds it, otherwise the next free one. It stays
    held until release()."""
    for port in range(preferred, preferred + 50):
        if port in _HELD:
            continue
        with socket.socket() as probe:
            if probe.connect_ex(('127.0.0.1', port)) != 0:
                _HELD.add(port)
                return port
    raise AgentError('Нет свободного порта, чтобы запустить агента из кода.')


def release(port: int | None) -> None:
    _HELD.discard(port)


class CodeAgent(HttpAgent):
    def __init__(self, config: dict) -> None:
        super().__init__({**config, 'url': '', 'profile': 'local'})
        self.preferred = int(config.get('port', 8081))
        self.port: int | None = None
        self.repo = Path(config['repo']).expanduser()
        self.process: subprocess.Popen | None = None

    async def open(self) -> None:
        script = self.repo / START
        if not script.exists():
            raise AgentError(f'Нет файла {script}. Проверьте папку с кодом в разделе «Агент».')
        self.port = free_port(self.preferred)
        self.url = f'http://127.0.0.1:{self.port}{AGENT_PATH}'
        log = store.database().parent / LOG
        store.private_folder(log.parent)
        # The agent's output may quote the bank's data: readable by this user only.
        descriptor = os.open(log, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, 'w') as output:
            self.process = subprocess.Popen(
                [str(script)],
                cwd=self.repo,
                env=environment(self.port),
                stdout=output,
                stderr=subprocess.STDOUT,
                start_new_session=True,
            )
        deadline = time.monotonic() + START_TIMEOUT
        async with httpx.AsyncClient(timeout=3) as client:
            while time.monotonic() < deadline:
                if self.process.poll() is not None:
                    raise AgentError(f'Агент из кода не запустился. Подробности — в {log}.')
                try:
                    identity = (await client.get(f'http://127.0.0.1:{self.port}/local/agent-lab/identity')).json()
                except (httpx.HTTPError, ValueError):
                    await asyncio.sleep(1)
                    continue
                if not isinstance(identity, dict):
                    raise AgentError('Агент из кода ответил в неизвестном формате (identity).')
                if identity.get('pid') != self.process.pid:
                    raise AgentError(
                        f'На порту {self.port} отвечает другой процесс агента (pid {identity.get("pid")}).'
                    )
                branch = self._branch()
                self.version = f'{identity.get("version")} · {branch}' if branch else str(identity.get('version'))
                return
        raise AgentError('Агент из кода не ответил за 3\u00a0минуты.')

    async def close(self) -> None:
        try:
            await self._stop()
        finally:
            release(self.port)

    async def _stop(self) -> None:
        if not self.process or self.process.poll() is not None:
            return
        try:
            os.killpg(self.process.pid, signal.SIGTERM)
            await asyncio.to_thread(self.process.wait, 15)
        except ProcessLookupError:
            pass
        except subprocess.TimeoutExpired:
            os.killpg(self.process.pid, signal.SIGKILL)
            await asyncio.to_thread(self.process.wait)

    def _branch(self) -> str:
        result = subprocess.run(['git', 'branch', '--show-current'], cwd=self.repo, capture_output=True, text=True)
        return result.stdout.strip()
