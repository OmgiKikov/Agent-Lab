"""An uploaded file stays within its limits whatever it claims about itself."""

import struct
import tracemalloc
import unittest
import zlib
from unittest.mock import patch

from test_logs import PAIR, excel

from lab import logs, policy_files


def one_part(name: str, body: bytes, declared: int, crc: int) -> bytes:
    """A zip archive of one deflated part, its sizes and checksum as given."""
    member = name.encode()
    local = struct.pack('<IHHHHHIIIHH', 0x04034B50, 20, 0, 8, 0, 0, crc, len(body), declared, len(member), 0)
    central = struct.pack(
        '<IHHHHHHIIIHHHHHII', 0x02014B50, 20, 20, 0, 8, 0, 0, crc, len(body), declared, len(member), 0, 0, 0, 0, 0, 0
    )
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
        with self.assertRaisesRegex(ValueError, 'Не удалось прочитать файл Excel'):
            logs.prepare('export.xlsx', one_part('[Content_Types].xml', b'\xff' * 64, 100, 0))
