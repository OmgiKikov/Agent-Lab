"""Exercise the actual startup module with isolated data and frontend directories."""

import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


class HostingTests(unittest.TestCase):
    def probe(self, script: str, *, built: bool) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            frontend = root / 'frontend'
            frontend.mkdir()
            if built:
                (frontend / 'index.html').write_text('<!doctype html><title>Agent Lab fixture</title>')
                (frontend / 'assets').mkdir()
                (frontend / 'assets/app.js').write_text('console.log("fixture")')
            environment = {
                **os.environ,
                'LAB_DATA': str(root / 'data'),
                'LAB_FRONTEND': str(frontend),
                'LAB_CERTS': str(root / 'certs'),
                'AGENT_LAB_GATEWAY_FILE': str(root / 'missing-gateway.json'),
                'LAB_MODEL_URL': 'http://127.0.0.1:9/v1',
            }
            result = subprocess.run(
                [sys.executable, '-c', script], env=environment, capture_output=True, text=True, timeout=15, check=False
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_python_serves_frontend_data_and_blocks_foreign_browser_commands(self) -> None:
        self.probe(
            """
import asyncio
from unittest.mock import AsyncMock, patch
import httpx
from lab.app import app
from lab import api

async def main():
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
        pages = ('/', '/lab', '/lab/logs/log-1', '/overview', '/logs/problems/r-1', '/simulations/review')
        for path in pages:
            response = await client.get(path)
            assert response.status_code == 200, (path, response.text)
            assert 'Agent Lab fixture' in response.text
        assert (await client.get('/assets/app.js')).status_code == 200
        assert (await client.get('/assets/%2e%2e/index.html')).status_code == 404
        assert (await client.get('/health')).json()['product'] == 'agent-lab'
        assert 'job' in (await client.get('/api/state')).json()
        assert (await client.get('/api/unknown')).status_code == 404
        assert (await client.get('/api')).status_code == 404
        with patch.object(api.llm, 'check', new=AsyncMock(return_value={'ok': True})) as check:
            for origin in ('https://example.com', 'http://localhost.example.com', 'null', 'http://['):
                response = await client.post('/api/models/check', headers={'Origin': origin})
                assert response.status_code == 403, (origin, response.text)
            check.assert_not_awaited()
            response = await client.post('/api/models/check', headers={'Origin': 'http://127.0.0.1:5900'})
            assert response.status_code == 200
            assert check.await_count == 2
        assert (await client.get('/favicon.svg')).status_code == 404

asyncio.run(main())
""",
            built=True,
        )

    def test_missing_frontend_is_an_actionable_error_and_api_still_works(self) -> None:
        self.probe(
            """
import asyncio
import httpx
from lab.app import app

async def main():
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
        response = await client.get('/lab')
        assert response.status_code == 503
        assert 'npm --prefix frontend run build' in response.json()['detail']
        assert (await client.get('/api/state')).status_code == 200

asyncio.run(main())
""",
            built=False,
        )
