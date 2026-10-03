"""The bank's gateway read from certs/. openssl makes the bundles here, in a temporary folder: no key is in Git."""

import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from lab.llm import gateway

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
            patcher = patch.object(gateway, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def reason(self) -> str:
        with self.assertRaises(gateway.ModelError) as caught:
            gateway.config()
        return str(caught.exception)


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
