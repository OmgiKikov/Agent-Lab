"""The Pi bridge serves only this computer's pages, never writes the customer's conversation into its log, and never
puts it on a command line, which every user of the computer can read."""

import importlib.util
import socket
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

    def test_the_conversation_never_reaches_a_command_line(self) -> None:
        """Pi reads the conversation from its standard input and the system prompt from a file only this user reads: a
        command line is visible to every user of the computer, and Linux refuses one argument over 128 KiB."""
        seen = {}

        def pi(command, **options):
            prompt = Path(command[command.index('--system-prompt') + 1])
            seen.update(command=command, input=options['input'], prompt=prompt.read_text(encoding='utf-8'))
            seen['mode'] = prompt.parent.stat().st_mode & 0o777
            seen['file'] = prompt
            return subprocess.CompletedProcess(command, 0, stdout='готов', stderr='')

        long = CUSTOMER + ' Очень длинный разговор.' * 8000  # well over 128 KiB in UTF-8
        body = {'messages': [{'role': 'system', 'content': 'Ты судья.'}, {'role': 'user', 'content': long}]}
        with patch.object(pi_bridge.subprocess, 'run', side_effect=pi):
            self.assertEqual(pi_bridge.run_pi(body), 'готов')
        self.assertFalse([part for part in seen['command'] if '7701234567' in part])
        self.assertIn(long, seen['input'])
        self.assertEqual(seen['prompt'], 'Ты судья.')
        self.assertEqual(seen['mode'], 0o700)
        self.assertFalse(seen['file'].exists())

    def test_a_wrong_token_or_a_broken_length_is_refused_without_running_pi(self) -> None:
        url = f'http://127.0.0.1:{self.port}/v1/chat/completions'
        with patch.object(pi_bridge.subprocess, 'run') as pi, httpx.Client(trust_env=False, timeout=10) as client:
            wrong = client.post(url, json={'messages': []}, headers={'Authorization': 'Bearer guess'})
            self.assertEqual(wrong.status_code, 401)
            pi.assert_not_called()
        request = (
            'POST /v1/chat/completions HTTP/1.1\r\n'
            f'Host: 127.0.0.1:{self.port}\r\nAuthorization: Bearer launch-token\r\nContent-Length: abc\r\n\r\n{{}}'
        )
        with socket.create_connection(('127.0.0.1', self.port), timeout=10) as connection:
            connection.sendall(request.encode())
            answer = connection.recv(1024).decode(errors='replace')
        self.assertTrue(answer.startswith(('HTTP/1.0 413', 'HTTP/1.1 413')), answer[:80])
