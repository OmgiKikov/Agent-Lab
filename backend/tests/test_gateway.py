"""The bank's gateway read from certs/. openssl makes the bundles here, in a temporary folder: no key is in Git."""

import asyncio
import os
import shutil
import subprocess
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx

from lab.llm import gateway

Client = httpx.AsyncClient
PASSWORD = 'Secret-1'
BUNDLES = Path()  # a temporary folder, from setUpModule


def setUpModule() -> None:
    """client.p12 as the bank issues it, the same in an older Windows export (RC2), and one without the key."""
    global BUNDLES
    BUNDLES = Path(tempfile.mkdtemp(prefix='agent-lab-bundles-'))
    key, cert = BUNDLES / 'key.pem', BUNDLES / 'cert.pem'
    openssl(
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-subj', '/CN=t', '-days', '1'
    )
    for name, options in (('modern', ('-inkey', key)), ('legacy', ('-inkey', key, '-legacy')), ('nokey', ('-nokeys',))):
        # No -legacy before OpenSSL 3: the RC2 tests are skipped there.
        openssl(
            'pkcs12', '-export', '-in', cert, *options, '-out', BUNDLES / f'{name}.p12', '-passout', 'stdin', ok=False
        )
    key.unlink()


def openssl(*args: object, ok: bool = True) -> None:
    subprocess.run(['openssl', *map(str, args)], input=f'{PASSWORD}\n'.encode(), capture_output=True, check=ok)


def tearDownModule() -> None:
    shutil.rmtree(BUNDLES, ignore_errors=True)


class GatewayCase(unittest.TestCase):
    """certs/ of its own: url.txt, client.p12 and password.txt; no settings file or environment."""

    bundle = 'modern'

    def setUp(self) -> None:
        if not (BUNDLES / f'{self.bundle}.p12').exists():
            self.skipTest(f'openssl here cannot make the {self.bundle} bundle')
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.certs = Path(folder.name) / 'certs'
        self.certs.mkdir()
        shutil.copy(BUNDLES / f'{self.bundle}.p12', self.certs / 'client.p12')
        (self.certs / 'url.txt').write_text('https://gateway.bank.test/v2\n')
        (self.certs / 'password.txt').write_text(PASSWORD + '\n')
        environment = patch.dict(os.environ)
        environment.start()
        self.addCleanup(environment.stop)
        for name in (*gateway._ENV.values(), 'AGENT_LAB_GATEWAY_INSECURE'):
            os.environ.pop(name, None)
        for name, value in (('CERTS', self.certs), ('FILE', Path(folder.name) / 'none.json')):
            self.patch(name, value)
        for name in ('_unpacked', '_built', '_session'):  # what earlier tests left in the caches
            self.patch(name, None)

    def patch(self, name: str, value: object) -> None:
        patcher = patch.object(gateway, name, value, create=True)
        patcher.start()
        self.addCleanup(patcher.stop)

    def reason(self) -> str:
        with self.assertRaises(gateway.ModelError) as caught:
            gateway.config()
        return str(caught.exception)

    def spy(self, target: object, name: str) -> list[bool]:
        """Calls of target.name from now on: for each, whether it ran on the main thread, where the event loop is."""
        calls = []
        real = getattr(target, name)

        def call(*args, **options):
            calls.append(threading.current_thread() is threading.main_thread())
            return real(*args, **options)

        patcher = patch.object(target, name, side_effect=call)
        patcher.start()
        self.addCleanup(patcher.stop)
        return calls

    def renew(self) -> None:
        """The bank's next bundle in place of this one."""
        bundle = self.certs / 'client.p12'
        stamp = bundle.stat()
        os.utime(bundle, ns=(stamp.st_atime_ns, stamp.st_mtime_ns + 1_000_000_000))


class BundleTests(GatewayCase):
    def test_the_password_reaches_openssl_on_stdin_never_its_command_line(self) -> None:
        calls = []
        real = subprocess.run

        def spy(command, **options):
            calls.append((command, options))
            return real(command, **options)

        with patch.object(gateway.subprocess, 'run', side_effect=spy):
            settings = gateway.config()
        self.assertEqual(settings['url'], 'https://gateway.bank.test')
        self.assertTrue(calls)
        for command, options in calls:
            self.assertNotIn(PASSWORD, ' '.join(map(str, command)))
            self.assertEqual(command[command.index('-passin') + 1], 'stdin')
            self.assertEqual(options['input'], f'{PASSWORD}\n'.encode())
        self.assertIn(b'BEGIN CERTIFICATE', Path(settings['cert']).read_bytes())
        self.assertIn(b'PRIVATE KEY', Path(settings['key']).read_bytes())
        self.assertEqual(Path(settings['key']).stat().st_mode & 0o777, 0o600)

    def test_a_wrong_password_names_password_txt_and_never_the_password(self) -> None:
        (self.certs / 'password.txt').write_text('Wrong-Pa55\n')
        reason = self.reason()
        self.assertIn('неверный пароль', reason)
        self.assertIn('password.txt', reason)
        self.assertNotIn('Wrong-Pa55', reason)
        self.assertNotIn('pkcs12', reason)
        self.assertTrue(gateway.configured())

    def test_no_password_for_a_closed_bundle_says_where_to_write_it(self) -> None:
        (self.certs / 'password.txt').unlink()
        self.assertIn('впишите его в', self.reason())

    def test_a_failed_conversion_keeps_the_previous_files(self) -> None:
        settings = gateway.config()
        before = Path(settings['cert']).read_bytes(), Path(settings['key']).read_bytes()
        (self.certs / 'password.txt').write_text('Wrong-Pa55\n')
        self.reason()
        self.assertEqual((Path(settings['cert']).read_bytes(), Path(settings['key']).read_bytes()), before)
        self.assertEqual(sorted(p.name for p in (self.certs / '.converted').iterdir()), ['client.key', 'client.pem'])

    def test_without_openssl_a_bundle_is_a_reason_not_a_crash(self) -> None:
        with tempfile.TemporaryDirectory() as empty, patch.dict(os.environ, {'PATH': empty}):
            self.assertIn('нужна программа openssl', self.reason())

    def test_a_bundle_without_the_key_is_a_reason(self) -> None:
        shutil.copy(BUNDLES / 'nokey.p12', self.certs / 'client.p12')
        self.assertIn('нет сертификата клиента с ключом', self.reason())


class LegacyBundleTests(GatewayCase):
    bundle = 'legacy'

    def test_an_rc2_bundle_from_older_windows_is_opened_with_the_legacy_provider(self) -> None:
        settings = gateway.config()
        self.assertIn(b'PRIVATE KEY', Path(settings['key']).read_bytes())

    def test_an_rc2_bundle_without_the_legacy_provider_is_a_reason(self) -> None:
        with tempfile.TemporaryDirectory() as empty, patch.dict(os.environ, {'OPENSSL_MODULES': empty}):
            self.assertIn('старом формате (RC2)', self.reason())


class ReuseTests(GatewayCase):
    """certs/ costs once, not on every call: one conversion, one TLS context, one client per event loop."""

    def test_five_calls_cost_one_conversion_one_context_and_one_client(self) -> None:
        conversions = self.spy(gateway.subprocess, 'run')
        contexts = self.spy(gateway.ssl, 'create_default_context')
        clients = []
        answer = {'messages': [{'role': 'assistant', 'content': [{'text': 'да'}]}]}

        def client(**options):
            clients.append(options)
            return Client(transport=httpx.MockTransport(lambda _: httpx.Response(200, json=answer)), **options)

        async def calls() -> None:
            for _ in range(5):
                await gateway.chat('glm', 'system', [{'role': 'user', 'content': 'вопрос'}], httpx.Timeout(5))

        with patch.object(gateway.httpx, 'AsyncClient', side_effect=client):
            asyncio.run(calls())
        self.assertEqual((len(conversions), len(contexts), len(clients)), (2, 1, 1))  # 2: the certificate and the key

    def test_a_renewed_bundle_is_converted_again_once(self) -> None:
        conversions = self.spy(gateway.subprocess, 'run')
        for _ in range(3):
            gateway.config()
        self.renew()
        for _ in range(3):
            gateway.config()
        self.assertEqual(len(conversions), 4)

    def test_a_broken_bundle_is_not_opened_again_on_every_call(self) -> None:
        (self.certs / 'password.txt').write_text('Wrong-Pa55\n')
        conversions = self.spy(gateway.subprocess, 'run')
        for _ in range(3):
            self.reason()
        self.assertEqual(len(conversions), 1)

    def test_openssl_runs_off_the_event_loop(self) -> None:
        conversions = self.spy(gateway.subprocess, 'run')
        asyncio.run(gateway._client())
        self.assertEqual(conversions, [False, False])

    def test_each_event_loop_has_its_client_and_a_renewal_gets_a_new_one(self) -> None:
        async def clients() -> list[httpx.AsyncClient]:
            first, again = (await gateway._client())[0], (await gateway._client())[0]
            self.renew()
            return [first, again, (await gateway._client())[0]]

        first, again, renewed = asyncio.run(clients())
        other = asyncio.run(gateway._client())[0]
        self.assertIs(first, again)
        self.assertFalse(first.is_closed)
        self.assertIsNot(renewed, first)
        self.assertIsNot(other, renewed)
