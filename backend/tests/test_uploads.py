"""An uploaded file stays within its limits whatever it claims about itself."""

import struct
import tracemalloc
import unittest
import zlib
from unittest.mock import patch

import support
from test_logs import PAIR, excel

from lab import logs, policy_files, store


def one_part(name: str, body: bytes, declared: int, crc: int, flags: int = 0) -> bytes:
    """A zip archive of one deflated part, its sizes, checksum and flags as given."""
    member = name.encode()
    sizes = (crc, len(body), declared, len(member))
    local = struct.pack('<IHHHHHIIIHH', 0x04034B50, 20, flags, 8, 0, 0, *sizes, 0)
    central = struct.pack('<IHHHHHHIIIHHHHHII', 0x02014B50, 20, 20, flags, 8, 0, 0, *sizes, 0, 0, 0, 0, 0, 0)
    end = struct.pack('<IHHHHIIH', 0x06054B50, 0, 0, 1, 1, len(central + member), len(local + member + body), 0)
    return local + member + body + central + member + end


def bomb(name: str, declared: int, inflated: int) -> bytes:
    """A part that declares a little and inflates to much more; its checksum is the declared bytes', so only reading
    past the declared size shows the lie."""
    packer = zlib.compressobj(9, zlib.DEFLATED, -15)
    body = b''.join(packer.compress(b' ' * (1 << 20)) for _ in range(inflated >> 20)) + packer.flush()
    return one_part(name, body, declared, zlib.crc32(b' ' * declared))


class ArchiveTests(unittest.TestCase):
    def test_a_zip_bomb_is_refused_without_inflating_it(self):
        for name, read, data in (
            ('rules.docx', policy_files.read, bomb('word/document.xml', 900_000, 64 << 20)),
            ('export.xlsx', logs.prepare, bomb('[Content_Types].xml', 1_000, 64 << 20)),
        ):
            with self.subTest(name=name):
                tracemalloc.start()
                try:
                    with self.assertRaises(ValueError):
                        read(name, data)
                    _, most = tracemalloc.get_traced_memory()
                finally:
                    tracemalloc.stop()
                self.assertLess(most, 8 << 20)

    def test_a_workbook_that_unpacks_past_the_limit_is_refused_by_its_size(self):
        with patch.object(logs, 'INFLATED', 1_000), self.assertRaisesRegex(ValueError, 'после распаковки'):
            logs.prepare('export.xlsx', excel(PAIR, '[1, 2]'))
        self.assertEqual(len(logs.prepare('export.xlsx', excel(PAIR, '[1, 2]'))), 1)

    def test_a_broken_archive_is_a_validation_error(self):
        garbage = one_part('word/document.xml', b'\xff' * 64, 100, 0)
        with self.assertRaisesRegex(ValueError, 'Не удалось прочитать документ Word'):
            policy_files.read('rules.docx', garbage)
        with self.assertRaisesRegex(ValueError, 'Файл .xlsx повреждён'):
            logs.prepare('export.xlsx', one_part('[Content_Types].xml', b'\xff' * 64, 100, 0))

    def test_an_archive_feature_python_does_not_read_is_a_validation_error(self):
        text = zlib.compressobj(9, zlib.DEFLATED, -15)
        body = text.compress(b'<x/>') + text.flush()
        for flags in (0x20, 0x40):  # compressed patched data, strong encryption
            with self.subTest(flags=flags):
                part = one_part('word/document.xml', body, 4, zlib.crc32(b'<x/>'), flags)
                with self.assertRaisesRegex(ValueError, 'Не удалось прочитать документ Word'):
                    policy_files.read('rules.docx', part)
                part = one_part('[Content_Types].xml', body, 4, zlib.crc32(b'<x/>'), flags)
                with self.assertRaisesRegex(ValueError, 'Файл .xlsx повреждён'):
                    logs.prepare('export.xlsx', part)


class UploadBodyTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        support.serve(self)
        self.uploads = (
            ('/api/logs?name=export.jsonl', logs),
            ('/api/tone-of-voice/read-file?name=rules.md', policy_files),
        )

    async def test_an_upload_that_declares_too_much_is_refused_before_it_is_read(self) -> None:
        pulled = []

        async def body():
            pulled.append(True)
            yield b'{}'

        for path, module in self.uploads:
            with self.subTest(path=path), patch.object(module, 'LIMIT', 10_000):
                response = await self.client.post(path, content=body(), headers={'Content-Length': '10001'})
                self.assertEqual(response.status_code, 413, response.text)
                self.assertIn('Файл больше', response.json()['detail'])
        self.assertEqual(pulled, [])

    async def test_an_upload_without_a_declared_length_is_read_no_further_than_the_limit(self) -> None:
        for path, module in self.uploads:
            pulled = 0

            async def endless():
                nonlocal pulled
                for _ in range(1_000):
                    pulled += 1
                    yield b' ' * 1_000

            with self.subTest(path=path), patch.object(module, 'LIMIT', 10_000):
                response = await self.client.post(path, content=endless())
                self.assertEqual(response.status_code, 413, response.text)
                self.assertLessEqual(pulled, 11)
        self.assertIsNone(store.load(logs.FILE))
