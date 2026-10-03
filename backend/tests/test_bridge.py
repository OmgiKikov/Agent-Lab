"""The Pi bridge serves only this computer's pages and never writes the customer's conversation into its log."""

import importlib.util
import subprocess
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

import httpx

_spec = importlib.util.spec_from_file_location('pi_bridge', Path(__file__).resolve().parents[1] / 'bridge/pi_bridge.py')
pi_bridge = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(pi_bridge)

CUSTOMER = 'КЛИЕНТ ООО Ромашка ИНН 7701234567: верните 15 000 руб.'


class BridgeTests(unittest.TestCase):
    def setUp(self) -> None:
        server = ThreadingHTTPServer(('127.0.0.1', 0), pi_bridge.Handler)
        threading.Thread(target=server.serve_forever, args=(0.05,), daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        self.port = server.server_address[1]
        token = patch.object(pi_bridge, 'TOKEN', 'launch-token')
        token.start()
        self.addCleanup(token.stop)

    def ask(self, host: str | None = None, path: str = '/v1/chat/completions') -> httpx.Response:
        headers = {'Authorization': 'Bearer launch-token', 'Host': host or f'127.0.0.1:{self.port}'}
        body = {'messages': [{'role': 'user', 'content': CUSTOMER}]}
        url = f'http://127.0.0.1:{self.port}{path}'
        with httpx.Client(trust_env=False, timeout=10) as client:
            if path == '/health':
                return client.get(url, headers=headers)
            return client.post(url, json=body, headers=headers)

    def test_a_page_under_a_name_of_its_own_is_refused(self) -> None:
        answered = subprocess.CompletedProcess([], 0, stdout='готов', stderr='')
        with patch.object(pi_bridge.subprocess, 'run', return_value=answered) as pi:
            for host in (
                'attacker.example',
                f'attacker.example:{self.port}',
                f'127.0.0.1.attacker.example:{self.port}',
            ):
                with self.subTest(host=host):
                    self.assertEqual(self.ask(host).status_code, 403)
                    self.assertEqual(self.ask(host, '/health').status_code, 403)
            pi.assert_not_called()
            for host in (f'127.0.0.1:{self.port}', f'localhost:{self.port}', 'localhost'):
                with self.subTest(host=host):
                    self.assertEqual(self.ask(host).json()['choices'][0]['message']['content'], 'готов')

    def test_the_log_never_carries_the_conversation(self) -> None:
        failures = (
            subprocess.TimeoutExpired(['pi', '--', f'USER:\n{CUSTOMER}'], 240),
            subprocess.CompletedProcess([], 1, stdout='', stderr=f'error in request: {CUSTOMER}'),
        )
        for failure in failures:
            with (
                self.subTest(failure=type(failure).__name__),
                patch.object(pi_bridge.subprocess, 'run', side_effect=[failure]),
                self.assertLogs(pi_bridge.logger, 'ERROR') as logs,
            ):
                self.assertEqual(self.ask().status_code, 502)
            self.assertNotIn('7701234567', '\n'.join(logs.output))
