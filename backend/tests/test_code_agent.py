import asyncio
import os
import socket
import sys
import tempfile
import unittest
from pathlib import Path

from lab import store
from lab.agents import source

# A stand-in for the agent's local/run-app.sh: it serves the identity check on APP_PORT under its own pid.
SERVER = """
import http.server, json, os
class Identity(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = json.dumps({'pid': os.getpid(), 'version': 'test'}).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, *args):
        pass
print('listening on', os.environ['APP_PORT'], flush=True)
http.server.HTTPServer(('127.0.0.1', int(os.environ['APP_PORT'])), Identity).serve_forever()
"""


def a_free_port() -> int:
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0))
        return probe.getsockname()[1]


class CodeAgentTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        script = self.root / 'repo' / 'local' / 'run-app.sh'
        script.parent.mkdir(parents=True)
        script.write_text(f'#!/bin/sh\nexec {sys.executable} -c "$SERVER"\n')
        script.chmod(0o755)
        os.environ['SERVER'] = SERVER
        self.addCleanup(os.environ.pop, 'SERVER', None)

    async def start(self, agent: source.CodeAgent, database: Path) -> None:
        store.AGENT.set(database)  # inside its own task, as a job inside its agent
        await agent.open()

    async def test_the_agent_writes_its_log_beside_the_database_of_the_agent_being_checked(self) -> None:
        agent = source.CodeAgent({'repo': str(self.root / 'repo'), 'port': a_free_port()})
        database = self.root / 'agents' / 'first' / 'lab.sqlite3'
        try:
            await asyncio.create_task(self.start(agent, database))
        finally:
            await agent.close()
        log = database.parent / 'local-code-agent.log'
        self.assertIn(f'listening on {agent.port}', log.read_text())
        self.assertEqual(log.stat().st_mode & 0o777, 0o600)

    async def test_two_agents_started_at_once_each_get_their_own_port(self) -> None:
        config = {'repo': str(self.root / 'repo'), 'port': a_free_port()}
        first, second = source.CodeAgent(config), source.CodeAgent(config)
        databases = [self.root / 'agents' / name / 'lab.sqlite3' for name in ('first', 'second')]
        try:
            await asyncio.gather(self.start(first, databases[0]), self.start(second, databases[1]))
            self.assertNotEqual(first.port, second.port)
            self.assertEqual((first.version, second.version), ('test', 'test'))
        finally:
            await asyncio.gather(first.close(), second.close())
        self.assertEqual(source.free_port(config['port']), config['port'])  # a stopped agent's port is free again
        source.release(config['port'])
