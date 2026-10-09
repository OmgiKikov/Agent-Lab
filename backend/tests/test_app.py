"""The app as the Lab serves it: the built pages and the API on settings of its own, and only to this computer's own
pages and names."""

import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

import httpx
import support

from lab import models
from lab.app import create


class HostingTests(unittest.IsolatedAsyncioTestCase):
    def client(self, *, built: bool, base_url: str = 'http://test', **values: object) -> httpx.AsyncClient:
        """A client of the app on settings of the test's own, with the built pages or without them, and a second judge
        named (the models answer nowhere: a test replaces the call it expects)."""
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        frontend = Path(folder.name)
        if built:
            (frontend / 'index.html').write_text('<!doctype html><title>Agent Lab fixture</title>')
            (frontend / 'assets').mkdir()
            (frontend / 'assets/app.js').write_text('console.log("fixture")')
        settings = support.lab(self, frontend=frontend, second_model='second-judge', **values)
        client = httpx.AsyncClient(transport=httpx.ASGITransport(app=create(settings)), base_url=base_url)
        self.addAsyncCleanup(client.aclose)
        return client

    async def test_python_serves_frontend_data_and_blocks_foreign_browser_commands(self) -> None:
        client = self.client(built=True)
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
        with patch.object(models, 'check', new=AsyncMock(return_value={'ok': True})) as check:
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

    async def test_a_page_on_another_name_reaches_neither_data_nor_pages(self) -> None:
        """DNS rebinding: a page on a name that resolves to 127.0.0.1 sends that name as its Host."""
        client = self.client(built=True)
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

    async def test_another_local_service_cannot_send_commands(self) -> None:
        """Jupyter, a stand's Swagger or `python -m http.server` is another origin on this computer: its page may post
        a simple form or text/plain body, which replaces the export or starts paid work."""
        client = self.client(built=False, base_url='http://127.0.0.1:5899')
        with patch.object(models, 'check', new=AsyncMock(return_value={'ok': True})) as check:
            others = (
                'http://localhost:8888',
                'http://127.0.0.1:5900',
                'http://localhost:5899',
                'https://127.0.0.1:5899',
            )
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

    async def test_a_person_can_add_a_name_of_this_computer(self) -> None:
        client = self.client(
            built=False, base_url='http://lab.internal:5899', allowed_hosts='lab.internal, Other.Local'
        )
        for host, status in (('lab.internal:5899', 200), ('other.local', 200), ('127.0.0.1:5899', 200), ('test', 400)):
            response = await client.get('/api/state', headers={'Host': host})
            assert response.status_code == status, (host, response.status_code)

    async def test_behind_a_reverse_proxy_the_page_is_the_address_the_browser_opened(self) -> None:
        """The gateway ends TLS and asks the Lab over http, by this computer's name or its own: the page's scheme and
        name come in X-Forwarded-Proto and X-Forwarded-Host, the name one a person added."""
        client = self.client(built=False, base_url='http://127.0.0.1:5899', allowed_hosts='lab.bank.example')
        page = {
            'Origin': 'https://lab.bank.example',
            'X-Forwarded-Proto': 'https',
            'X-Forwarded-Host': 'lab.bank.example',
        }
        with patch.object(models, 'check', new=AsyncMock(return_value={'ok': True})) as check:
            for host in ('127.0.0.1:5899', 'agent-lab.internal:8080'):
                response = await client.post('/api/models/check', headers={**page, 'Host': host})
                assert response.status_code == 200, (host, response.text)
            foreign = {**page, 'Host': '127.0.0.1:5899', 'Origin': 'https://evil.example'}
            assert (await client.post('/api/models/check', headers=foreign)).status_code == 403
            assert check.await_count == 4  # two commands, each checking both models (a second judge is named)
        # A name the gateway forwards that nobody added says where to add it.
        headers = {'Host': '127.0.0.1:5899', 'X-Forwarded-Host': 'other.example'}
        response = await client.get('/api/state', headers=headers)
        assert response.status_code == 400 and 'LAB_ALLOWED_HOSTS' in response.json()['detail']

    async def test_a_page_on_another_name_cannot_say_it_is_this_computer(self) -> None:
        """DNS rebinding with X-Forwarded-Host, which any script may add to its own request: the Host still names the
        page's own name, and «127.0.0.1» in the header does not make it this computer's."""
        client = self.client(built=True)
        for forged in ('127.0.0.1:5899', 'localhost', '[::1]'):
            headers = {'Host': 'attacker.example:5899', 'X-Forwarded-Host': forged, 'X-Forwarded-Proto': 'http'}
            for path in ('/api/state', '/overview'):
                assert (await client.get(path, headers=headers)).status_code == 400, (forged, path)

    async def test_the_browsers_word_that_a_command_is_from_the_page_itself_is_believed(self) -> None:
        """A proxy that hides the page's address leaves the browser's word, Sec-Fetch-Site, which no script can set.
        Another site or another local service says otherwise and is refused, into the server log."""
        client = self.client(built=False, base_url='http://127.0.0.1:5899')
        with patch.object(models, 'check', new=AsyncMock(return_value={'ok': True})) as check:
            same = {'Origin': 'https://lab.bank.example', 'Sec-Fetch-Site': 'same-origin'}
            assert (await client.post('/api/models/check', headers=same)).status_code == 200
            with self.assertLogs('lab.app', level='WARNING') as logged:
                for site in ('cross-site', 'same-site'):
                    headers = {'Origin': 'http://localhost:8888', 'Sec-Fetch-Site': site}
                    assert (await client.post('/api/models/check', headers=headers)).status_code == 403, site
            assert check.await_count == 2  # one command, checking both models
        assert 'Отклонён запрос POST /api/models/check: Origin http://localhost:8888' in logged.output[0]

    async def test_the_page_is_revalidated_never_framed_and_hashed_assets_are_kept(self) -> None:
        client = self.client(built=True)
        page = await client.get('/overview')
        assert page.headers.get('cache-control') == 'no-cache', page.headers
        asset = await client.get('/assets/app.js')
        assert 'immutable' in asset.headers.get('cache-control', ''), asset.headers
        # No other site shows the Lab in a frame to have a person click in it.
        for response in (page, asset, await client.get('/api/state')):
            assert response.headers.get('x-frame-options') == 'DENY', response.headers
            assert response.headers.get('content-security-policy') == "frame-ancestors 'none'", response.headers
            assert response.headers.get('x-content-type-options') == 'nosniff', response.headers

    async def test_missing_frontend_is_an_actionable_error_and_api_still_works(self) -> None:
        client = self.client(built=False)
        response = await client.get('/lab')
        assert response.status_code == 503
        assert 'npm --prefix frontend run build' in response.json()['detail']
        assert (await client.get('/api/state')).status_code == 200
