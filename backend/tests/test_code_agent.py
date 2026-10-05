import asyncio
import os
import socket
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import support

from lab import store
from lab.agents import code
from lab.flows import connection

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
keys = ('LAB_MODEL_KEY', 'LAB_SECOND_KEY', 'OPENROUTER_API_KEY', 'AGENT_LAB_GATEWAY')
print('lab keys', sorted(k for k in os.environ if k.startswith(keys)), flush=True)
print('own settings', os.environ.get('SBE_TOOL_NAME_CARD'), flush=True)
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

    def started(self, database: Path) -> code.CodeAgent:
        """An agent from its code as a run of the agent whose database this is would start it."""
        return code.CodeAgent(
            {'repo': str(self.root / 'repo'), 'port': a_free_port(), 'log': database.parent / code.LOG}
        )

    async def test_the_agent_writes_its_log_beside_the_database_of_the_agent_being_checked(self) -> None:
        support.lab(self)
        database = self.root / 'agents' / 'first' / 'lab.sqlite3'

        async def connect() -> code.CodeAgent:
            store.AGENT.set(database)  # inside its own task, as a job inside its agent
            connection.save_settings({'repo': str(self.root / 'repo')})
            agent = connection.connect('local-code')
            await agent.open()
            return agent

        task = asyncio.create_task(connect())
        try:
            agent = await task
        finally:
            if task.done() and not task.exception():
                await task.result().close()
        log = database.parent / 'local-code-agent.log'
        self.assertIn(f'listening on {agent.port}', log.read_text())
        self.assertEqual(log.stat().st_mode & 0o777, 0o600)

    async def test_the_agent_starts_without_the_labs_keys(self) -> None:
        secrets = {
            'LAB_MODEL_KEY': 'sk-or-main',
            'LAB_SECOND_KEY': 'sk-or-second',
            'OPENROUTER_API_KEY': 'sk-or-lab',
            'AGENT_LAB_GATEWAY_KEY_PATH': '/certs/client.key',
            'SBE_TOOL_NAME_CARD': 'card-tool',  # the agent's own setting reaches it
        }
        environment = patch.dict(os.environ, secrets)
        environment.start()
        self.addCleanup(environment.stop)
        database = self.root / 'agents' / 'first' / 'lab.sqlite3'
        database.parent.mkdir(parents=True)
        agent = self.started(database)
        try:
            await agent.open()
        finally:
            await agent.close()
        log = (database.parent / 'local-code-agent.log').read_text()
        self.assertIn('lab keys []', log)
        self.assertIn('own settings card-tool', log)

    async def test_two_agents_started_at_once_each_get_their_own_port(self) -> None:
        port = a_free_port()
        databases = [self.root / 'agents' / name / 'lab.sqlite3' for name in ('first', 'second')]
        for database in databases:
            database.parent.mkdir(parents=True)
        first, second = (
            code.CodeAgent({'repo': str(self.root / 'repo'), 'port': port, 'log': database.parent / code.LOG})
            for database in databases
        )
        try:
            await asyncio.gather(first.open(), second.open())
            self.assertNotEqual(first.port, second.port)
            self.assertEqual((first.version, second.version), ('test', 'test'))
        finally:
            await asyncio.gather(first.close(), second.close())
        self.assertEqual(code.free_port(port), port)  # a stopped agent's port is free again
        code.release(port)
