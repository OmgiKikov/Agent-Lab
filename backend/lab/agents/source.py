"""The agent started from its repository (local/run-app.sh) on its own port for the time of one run."""

import asyncio
import os
import signal
import socket
import subprocess
import time
from pathlib import Path

import httpx

from ..settings import DATA
from .http import AGENT_PATH, AgentError, HttpAgent

LOG = DATA / 'local-code-agent.log'
START_TIMEOUT = 180


def free_port(preferred: int) -> int:
    """The preferred port if nobody listens on it, otherwise the next free one."""
    for port in range(preferred, preferred + 50):
        with socket.socket() as probe:
            if probe.connect_ex(('127.0.0.1', port)) != 0:
                return port
    raise AgentError('Нет свободного порта для агента из исходников')


class CodeAgent(HttpAgent):
    def __init__(self, config: dict):
        self.port = free_port(int(config.get('port', 8081)))
        super().__init__({**config, 'url': f'http://127.0.0.1:{self.port}{AGENT_PATH}', 'profile': 'local'})
        self.repo = Path(config['repo']).expanduser()
        self.process: subprocess.Popen | None = None

    async def open(self) -> None:
        script = self.repo / 'local/run-app.sh'
        if not script.exists():
            raise AgentError(f'Нет исходников агента: {script}')
        LOG.parent.mkdir(parents=True, exist_ok=True)
        with LOG.open('w') as log:
            self.process = subprocess.Popen(
                [str(script)],
                cwd=self.repo,
                env={**os.environ, 'APP_PORT': str(self.port)},
                stdout=log,
                stderr=subprocess.STDOUT,
                start_new_session=True,
            )
        deadline = time.monotonic() + START_TIMEOUT
        async with httpx.AsyncClient(timeout=3) as client:
            while time.monotonic() < deadline:
                if self.process.poll() is not None:
                    raise AgentError('Агент из исходников не запустился: см. data/local-code-agent.log')
                try:
                    identity = (await client.get(f'http://127.0.0.1:{self.port}/local/agent-lab/identity')).json()
                except (httpx.HTTPError, ValueError):
                    await asyncio.sleep(1)
                    continue
                if not isinstance(identity, dict):
                    raise AgentError('Проверка агента вернула неверный формат identity')
                if identity.get('pid') != self.process.pid:
                    raise AgentError(f'На порту {self.port} отвечает чужой процесс агента (pid {identity.get("pid")})')
                branch = self._branch()
                self.version = f'{identity.get("version")} · {branch}' if branch else str(identity.get('version'))
                return
        raise AgentError('Агент из исходников не ответил за 3 минуты')

    async def close(self) -> None:
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
