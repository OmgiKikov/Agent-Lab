"""The bank's gateway read from certs/. openssl makes the bundles here, in a temporary folder: no key is in Git."""

import asyncio
import json
import os
import shutil
import sqlite3
import ssl
import subprocess
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import AsyncMock, patch

import httpx
import support

from lab import config, models, roles, storage
from lab.app import create
from lab.models import gateway

Client = httpx.AsyncClient
PASSWORD = 'Secret-1'
BUNDLES = Path()  # a temporary folder, from setUpModule


def setUpModule() -> None:
    """client.p12 as the bank issues it, the same in an older Windows export (RC2), one without the key; and the
    certificate and key in PEM, the key also encrypted with PASSWORD; another authority's certificate and key."""
    global BUNDLES
    BUNDLES = Path(tempfile.mkdtemp(prefix='agent-lab-bundles-'))
    key, cert = BUNDLES / 'client.key', BUNDLES / 'client.pem'
    for name in ('client', 'other'):  # the other one also serves as a gateway on this computer (TlsTests)
        openssl(
            'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', BUNDLES / f'{name}.key',
            '-out', BUNDLES / f'{name}.pem', '-subj', '/CN=t', '-addext', 'subjectAltName=IP:127.0.0.1', '-days', '1',
        )  # fmt: skip
    openssl('pkey', '-in', key, '-aes256', '-out', BUNDLES / 'encrypted.key', '-passout', 'stdin')
    for name, options in (('modern', ('-inkey', key)), ('legacy', ('-inkey', key, '-legacy')), ('nokey', ('-nokeys',))):
        # No -legacy before OpenSSL 3: the RC2 tests are skipped there.
        openssl(
            'pkcs12', '-export', '-in', cert, *options, '-out', BUNDLES / f'{name}.p12', '-passout', 'stdin', ok=False
        )


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
        self.settings = support.lab(self, certs=self.certs, gateway_file=Path(folder.name) / 'none.json')
        for name in ('_unpacked', '_built', '_session'):  # what earlier tests left in the caches
            self.patch(name, None)

    def patch(self, name: str, value: object) -> None:
        patcher = patch.object(gateway, name, value, create=True)
        patcher.start()
        self.addCleanup(patcher.stop)

    def reason(self) -> str:
        with self.assertRaises(gateway.ModelError) as caught:
            gateway.settings()
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
            settings = gateway.settings()
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
        self.assertIn('Впишите его в', self.reason())

    def test_a_failed_conversion_keeps_the_previous_files(self) -> None:
        settings = gateway.settings()
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


class SetupTests(GatewayCase):
    """certs/url.txt is there, something else is wrong: the reason names the file, and it is still the gateway."""

    def broken(self) -> str:
        reason = self.reason()
        self.assertEqual(gateway.problem(), reason)
        self.assertTrue(gateway.configured())
        return reason

    def pem(self, key: str = 'client.key') -> None:
        """The certificate and key as PEM files instead of the bundle."""
        (self.certs / 'client.p12').unlink()
        shutil.copy(BUNDLES / 'client.pem', self.certs / 'client.pem')
        shutil.copy(BUNDLES / key, self.certs / 'client.key')

    def test_an_empty_url_txt_says_to_write_the_address(self) -> None:
        (self.certs / 'url.txt').write_text('\n')
        self.assertIn('url.txt пустой. Впишите в него адрес шлюза', self.broken())

    def test_url_txt_must_hold_an_address(self) -> None:
        for text in ('gateway.bank.test', 'https://gateway:84 43'):
            with self.subTest(text=text):
                (self.certs / 'url.txt').write_text(text)
                self.assertIn('url.txt не адрес шлюза', self.broken())

    def test_an_unreadable_url_txt_is_named(self) -> None:
        (self.certs / 'url.txt').unlink()
        (self.certs / 'url.txt').mkdir()
        self.assertIn('url.txt не читается', self.broken())

    def test_an_unreadable_password_txt_is_named(self) -> None:
        (self.certs / 'password.txt').unlink()
        (self.certs / 'password.txt').mkdir()
        self.assertIn('password.txt не читается', self.broken())

    def test_url_txt_without_a_certificate_is_still_the_gateway(self) -> None:
        (self.certs / 'client.p12').unlink()
        self.assertIn('нет сертификата и ключа шлюза', self.broken())

    def test_certificates_are_known_by_what_they_hold_whatever_their_names(self) -> None:
        """A test stand's files as they travel: new_cert.c-r-t, key.k-e-y and ca-chain.cert.pem."""
        (self.certs / 'client.p12').unlink()
        shutil.copy(BUNDLES / 'client.pem', self.certs / 'new_cert.c-r-t')
        shutil.copy(BUNDLES / 'client.key', self.certs / 'key.k-e-y')
        shutil.copy(BUNDLES / 'other.pem', self.certs / 'ca-chain.cert.pem')
        found = gateway.settings()
        self.assertEqual(
            {name: Path(found[name]).name for name in ('cert', 'key', 'ca')},
            {'cert': 'new_cert.c-r-t', 'key': 'key.k-e-y', 'ca': 'ca-chain.cert.pem'},
        )
        self.assertIsNone(gateway.problem())

    def test_insecure_in_the_environment_holds_for_certs_too(self) -> None:
        self.assertFalse(gateway.settings()['insecure'])
        with config.using(support.changed(self.settings, gateway_insecure=True)):
            self.assertTrue(gateway.settings()['insecure'])

    def test_without_url_txt_there_is_no_gateway(self) -> None:
        (self.certs / 'url.txt').unlink()
        self.assertFalse(gateway.configured())
        self.assertIsNone(gateway.problem())

    def test_a_broken_settings_file_is_named(self) -> None:
        wrong = '{"format": "agent-lab-gateway-1", "url": 5, "certPath": "c.pem", "keyPath": "c.key"}'
        for text in ('[]', wrong):
            with self.subTest(text=text):
                self.settings.gateway_file.write_text(text)
                self.assertIn(str(self.settings.gateway_file), self.broken())

    def test_a_certificate_and_a_key_that_do_not_open_are_named(self) -> None:
        self.pem()
        (self.certs / 'client.key').write_text('-----BEGIN PRIVATE KEY-----\nbroken\n-----END PRIVATE KEY-----\n')
        reason = gateway.problem()
        self.assertIn('client.pem', reason)
        self.assertIn('client.key', reason)

    def test_an_encrypted_key_opens_with_password_txt_and_is_never_asked_for_on_the_terminal(self) -> None:
        self.pem('encrypted.key')
        self.assertIsNone(gateway.problem())
        (self.certs / 'password.txt').unlink()
        passwords = []
        real = ssl.SSLContext.load_cert_chain

        def load(context, *args, **options):
            passwords.append(options.get('password'))
            return real(context, *args, **options)

        with patch.object(ssl.SSLContext, 'load_cert_chain', load):
            self.assertIn('password.txt', gateway.problem())
        self.assertEqual(passwords, [b''])  # None would let OpenSSL wait for the password on the terminal

    def test_every_model_call_answers_with_the_reason_and_the_settings_show_it(self) -> None:
        (self.certs / 'url.txt').write_text('')
        reason = self.reason()
        on_gateway = support.changed(self.settings, model_url=None, model='requested')
        with config.using(on_gateway), patch.object(gateway, 'chosen_models', return_value={}):
            self.assertEqual(models.endpoints().main, (models.GATEWAY, 'requested'))
            asked = (
                lambda: models.chat('system', 'question'),
                lambda: roles.ask(roles.Role('test', 'system', dict), {}),
            )
            for call in asked:
                with self.assertRaises(models.ModelError) as caught:
                    asyncio.run(call())
                self.assertEqual(str(caught.exception), reason)
            self.assertEqual(asyncio.run(models.check(models.endpoints().main)), {'ok': False, 'error': reason})
            self.assertEqual(models.describe()['problem'], reason)

    def test_the_backend_starts_with_broken_certificates_and_stays_on_the_gateway(self) -> None:
        (self.certs / 'url.txt').write_text('')
        started = config.Settings.from_environment(
            {
                'LAB_DATA': str(self.certs.parent / 'data'),
                'LAB_CERTS': str(self.certs),
                'AGENT_LAB_GATEWAY_FILE': str(self.settings.gateway_file),
            }
        )
        with config.using(started), patch.object(gateway, 'chosen_models', return_value={}):
            self.assertEqual(models.endpoints().main[0], models.GATEWAY)
            self.assertIn('url.txt пустой', models.describe()['problem'])

    def test_starting_the_lab_on_the_gateway_opens_no_database(self) -> None:
        """Importing the Lab reads no agent's database. A database
        from before agents stays as it was until the start adopts it, so its backup is the file as it was; a fresh
        folder gets no empty database; the second judge comes only from LAB_SECOND_MODEL."""
        data = self.certs.parent / 'data'
        data.mkdir()
        legacy = data / 'lab.sqlite3'
        connection = sqlite3.connect(legacy)
        connection.execute('CREATE TABLE documents (name TEXT PRIMARY KEY, value TEXT NOT NULL)')
        result = {'finishedAt': 'then', 'topics': [], 'results': [{'dialogueId': 'd1', 'status': 'PASS', 'rules': []}]}
        connection.execute("INSERT INTO documents VALUES ('discover.json', ?)", (json.dumps(result),))
        connection.execute('INSERT INTO documents VALUES (\'models.json\', \'{"model": "glm-old"}\')')
        connection.commit()
        connection.close()
        before = legacy.read_bytes()
        environment = {'LAB_DATA': str(data), 'LAB_CERTS': str(self.certs)}
        environment['AGENT_LAB_GATEWAY_FILE'] = str(self.settings.gateway_file)
        started = config.Settings.from_environment(environment)
        with config.using(started):
            create(started)
            found = models.endpoints()
        self.assertEqual((found.main, found.second), ((models.GATEWAY, 'auto'), (models.GATEWAY, 'auto')))
        self.assertEqual(legacy.read_bytes(), before)
        legacy.unlink()
        with config.using(support.changed(started, data=data)):
            create(started)
            models.endpoints()
        self.assertFalse(legacy.exists())


class _Models(BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # the name http.server calls
        body = json.dumps({'data': [{'id': 'glm-5', 'type': 'chat'}]}).encode()
        self.send_response(200)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_: object) -> None:
        pass


class TlsTests(GatewayCase):
    """A gateway on this computer: what TLS refuses is said in words, at once, and never asked again."""

    def serve(self, *, client_from: Path | None = None) -> None:
        """The gateway with its own certificate; client_from: the authority whose client certificates it takes (TLS
        1.2, where a refusal comes in the handshake)."""
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(BUNDLES / 'other.pem', BUNDLES / 'other.key')
        if client_from:
            context.maximum_version = ssl.TLSVersion.TLSv1_2
            context.verify_mode = ssl.CERT_REQUIRED
            context.load_verify_locations(client_from)
        server = ThreadingHTTPServer(('127.0.0.1', 0), _Models)
        server.socket = context.wrap_socket(server.socket, server_side=True)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        (self.certs / 'url.txt').write_text(f'https://127.0.0.1:{server.server_address[1]}\n')

    def test_a_gateway_certificate_nobody_vouches_for_names_the_root_certificate_and_insecure(self) -> None:
        self.serve()
        with self.assertRaises(gateway.ModelError) as caught:
            asyncio.run(gateway.catalog())
        self.assertEqual(str(caught.exception), gateway.UNVERIFIED)
        with config.using(support.changed(self.settings, gateway_insecure=True)):
            self.assertEqual(asyncio.run(gateway.catalog()), ['glm-5'])

    def test_the_gateway_vouched_for_by_the_root_certificate_in_certs_answers(self) -> None:
        self.serve()
        shutil.copy(BUNDLES / 'other.pem', self.certs / 'ca.pem')
        self.assertEqual(asyncio.run(gateway.catalog()), ['glm-5'])

    def test_a_client_certificate_the_gateway_does_not_take_is_named_and_not_asked_again(self) -> None:
        self.serve(client_from=BUNDLES / 'other.pem')
        with config.using(support.changed(self.settings, gateway_insecure=True)):
            reason = asyncio.run(models.check((models.GATEWAY, 'glm-5')))
        self.assertFalse(reason['ok'])
        self.assertIn('шлюз не принял клиентский сертификат', reason['error'])
        self.assertIn('UNKNOWN_CA', reason['error'])


class LegacyBundleTests(GatewayCase):
    bundle = 'legacy'

    def test_an_rc2_bundle_from_older_windows_is_opened_with_the_legacy_provider(self) -> None:
        settings = gateway.settings()
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
            gateway.settings()
        self.renew()
        for _ in range(3):
            gateway.settings()
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


class AutoModelTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        support.lab(self)

    async def chosen(self, names: list[str]) -> str | None:
        with patch.object(gateway, 'catalog', AsyncMock(return_value=names)):
            return (await gateway.auto_models())['model']

    async def test_the_newest_full_glm_is_chosen_by_its_numbers_not_its_letters(self) -> None:
        self.assertEqual(await self.chosen(['glm-5.9', 'GLM-5.10', 'glm-5.11-flash', 'glm-4.6', 'gpt-oss']), 'GLM-5.10')

    async def test_without_a_full_glm_the_newest_light_one_and_without_glm_the_first_model(self) -> None:
        self.assertEqual(await self.chosen(['glm-4.5-air', 'glm-4.10-flash', 'qwen']), 'glm-4.10-flash')
        storage.documents.save(gateway.MODELS, {})
        self.assertEqual(await self.chosen(['qwen', 'gpt-oss']), 'qwen')
