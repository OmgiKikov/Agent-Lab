"""Exercise the actual startup module with isolated data and frontend directories."""

import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

# The tests address the app as http://test, a name lab.app answers to only from LAB_ALLOWED_HOSTS. tests/__init__.py
# says so too, but discovery (-s tests) imports the test modules and not the package: from here it reaches the whole
# run, which imports every module before its first test, and every probe below.
os.environ.setdefault('LAB_ALLOWED_HOSTS', 'test')


class HostingTests(unittest.TestCase):
    def probe(self, script: str, *, built: bool, **settings: str) -> None:
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
                'LAB_SECOND_MODEL': 'second-judge',
                **settings,
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
            # The Vite dev proxy keeps the page's Host (changeOrigin: false), so its Origin is the request's own.
            headers = {'Origin': 'http://127.0.0.1:5900', 'Host': '127.0.0.1:5900'}
            response = await client.post('/api/models/check', headers=headers)
            assert response.status_code == 200
            assert check.await_count == 2
        assert (await client.get('/favicon.svg')).status_code == 404

asyncio.run(main())
""",
            built=True,
        )

    def test_a_page_on_another_name_reaches_neither_data_nor_pages(self) -> None:
        """DNS rebinding: a page on a name that resolves to 127.0.0.1 sends that name as its Host."""
        self.probe(
            """
import asyncio
import httpx
from lab.app import app

async def main():
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
        foreign = ('attacker.example:5899', 'attacker.example', '127.0.0.1.attacker.example', 'localhost:5899@x', '')
        for host in foreign:
            for path in ('/api/state', '/overview', '/assets/app.js', '/health'):
                response = await client.get(path, headers={'Host': host})
                assert response.status_code == 400, (host, path, response.status_code)
                assert 'LAB_ALLOWED_HOSTS' in response.json()['detail']
            assert (await client.post('/api/job/stop', headers={'Host': host})).status_code == 400, host
        for host in ('127.0.0.1:5899', 'localhost:5900', 'LocalHost', '[::1]:5899', '127.0.0.1'):
            response = await client.get('/api/state', headers={'Host': host})
            assert response.status_code == 200, (host, response.text)

asyncio.run(main())
""",
            built=True,
        )

    def test_another_local_service_cannot_send_commands(self) -> None:
        """Jupyter, a stand's Swagger or `python -m http.server` is another origin on this computer: its page may post
        a simple form or text/plain body, which replaces the export or starts paid work."""
        self.probe(
            """
import asyncio
import httpx
from unittest.mock import AsyncMock, patch
from lab import api
from lab.app import app

async def main():
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://127.0.0.1:5899') as client:
        with patch.object(api.llm, 'check', new=AsyncMock(return_value={'ok': True})) as check:
            others = ('http://localhost:8888', 'http://127.0.0.1:5900', 'http://localhost:5899', 'https://127.0.0.1:5899')
            for origin in others:
                response = await client.post('/api/models/check', headers={'Origin': origin})
                assert response.status_code == 403, (origin, response.status_code)
            headers = {'Origin': 'http://localhost:8888', 'Content-Type': 'text/plain'}
            response = await client.post('/api/logs?name=a.jsonl', content='{}', headers=headers)
            assert response.status_code == 403, response.status_code
            check.assert_not_awaited()
            for headers in ({'Origin': 'http://127.0.0.1:5899'}, {}):
                response = await client.post('/api/models/check', headers=headers)
                assert response.status_code == 200, (headers, response.status_code)
        assert (await client.get('/api/state', headers={'Origin': 'http://localhost:8888'})).status_code == 200

asyncio.run(main())
""",
            built=False,
        )

    def test_a_person_can_add_a_name_of_this_computer(self) -> None:
        self.probe(
            """
import asyncio
import httpx
from lab.app import app

async def main():
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://lab.internal:5899') as client:
        for host, status in (('lab.internal:5899', 200), ('other.local', 200), ('127.0.0.1:5899', 200), ('test', 400)):
            response = await client.get('/api/state', headers={'Host': host})
            assert response.status_code == status, (host, response.status_code)

asyncio.run(main())
""",
            built=False,
            LAB_ALLOWED_HOSTS='lab.internal, Other.Local',
        )

    def test_the_page_is_revalidated_never_framed_and_hashed_assets_are_kept(self) -> None:
        self.probe(
            """
import asyncio
import httpx
from lab.app import app

async def main():
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
        page = await client.get('/overview')
        assert page.headers.get('cache-control') == 'no-cache', page.headers
        asset = await client.get('/assets/app.js')
        assert 'immutable' in asset.headers.get('cache-control', ''), asset.headers
        # No other site shows the Lab in a frame to have a person click in it.
        for response in (page, asset, await client.get('/api/state')):
            assert response.headers.get('x-frame-options') == 'DENY', response.headers
            assert response.headers.get('content-security-policy') == "frame-ancestors 'none'", response.headers
            assert response.headers.get('x-content-type-options') == 'nosniff', response.headers

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
