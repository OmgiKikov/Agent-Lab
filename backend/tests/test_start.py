"""bin/start.sh as a person runs it: where the conversations go is decided here. uv and npm are stand-ins that note how
they were called; the backend, the certificates' probe and the Pi bridge run for real (Pi itself is a stand-in)."""

import os
import queue
import signal
import socket
import subprocess
import tempfile
import threading
import time
import unittest
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[2]


def free_port() -> int:
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0))
        return probe.getsockname()[1]


def ready(url: str) -> httpx.Response:
    """The answer once something listens there; 30 s at most."""
    deadline = time.monotonic() + 30
    while True:
        try:
            return httpx.get(url, timeout=2, trust_env=False)
        except httpx.TransportError:
            if time.monotonic() > deadline:
                raise
            time.sleep(0.2)


@unittest.skipUnless((ROOT / 'backend/.venv/bin/python').exists(), 'bin/start.sh runs the backend from backend/.venv')
class StartTests(unittest.TestCase):
    def setUp(self) -> None:
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.folder = Path(folder.name)
        self.certs = self.folder / 'certs'
        self.certs.mkdir()
        self.tools = self.folder / 'tools'
        self.tools.mkdir()
        for name in ('uv', 'npm'):
            self.tool(name, f'echo "{name} $(pwd) $*" >> "{self.folder}/calls"')
        self.port = free_port()

    def tool(self, name: str, script: str) -> Path:
        path = self.tools / name
        path.write_text(f'#!/bin/sh\n{script}\n')
        path.chmod(0o755)
        return path

    def start(self, **settings: str) -> str:
        """What bin/start.sh printed up to the address of the page; it keeps running until the test ends."""
        environment = {k: v for k, v in os.environ.items() if not k.startswith(('LAB_', 'PI_', 'AGENT_LAB'))}
        environment.update(
            HOME=str(self.folder),
            PATH=f'{self.tools}:{environment["PATH"]}',
            LAB_PORT=str(self.port),
            LAB_DATA=str(self.folder / 'data'),
            LAB_CERTS=str(self.certs),
            AGENT_LAB_GATEWAY_FILE=str(self.folder / 'none.json'),
            **settings,
        )
        process = subprocess.Popen(
            ['sh', str(ROOT / 'bin/start.sh')],
            env=environment,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            start_new_session=True,  # its own process group: the test stops all it started
        )
        lines: queue.Queue = queue.Queue()
        reader = threading.Thread(target=lambda: [*map(lines.put, process.stdout), lines.put('')], daemon=True)
        reader.start()
        self.addCleanup(self.stop, process, reader)
        printed = ''
        while 'Agent Lab:' not in printed:
            line = lines.get(timeout=60)
            if not line:
                self.fail(f'bin/start.sh stopped:\n{printed}')
            printed += line
        return printed

    def stop(self, process: subprocess.Popen, reader: threading.Thread) -> None:
        try:
            os.killpg(process.pid, signal.SIGTERM)
            process.wait(20)
        except ProcessLookupError:
            pass
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
        reader.join(10)
        process.stdout.close()

    def test_broken_certificates_start_no_pi_and_the_page_says_why(self) -> None:
        (self.certs / 'url.txt').write_text('')
        printed = self.start()
        self.assertIn('Шлюз банка не работает: ', printed)
        self.assertIn('url.txt пустой', printed)
        self.assertNotIn('OpenRouter через Pi', printed)
        self.assertIn(f'Agent Lab: http://127.0.0.1:{self.port}/\n', printed)
        self.assertNotIn('backend/bridge', (self.folder / 'calls').read_text())  # Pi's npm ci never ran
        ready(f'http://127.0.0.1:{self.port}/health')
        state = httpx.get(f'http://127.0.0.1:{self.port}/api/state', timeout=10, trust_env=False).json()
        self.assertEqual(state['models']['via'], 'шлюз банка')
        self.assertIn('url.txt пустой', state['models']['problem'])
        self.assertFalse((self.folder / 'data/bridge.log').exists())  # no bridge was started
