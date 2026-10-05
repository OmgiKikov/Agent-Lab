"""bin/copy_check.py reads the texts people read (docs/WRITING.md): what it reads as a text is checked here."""

import importlib.util
import unittest
from pathlib import Path

SPEC = importlib.util.spec_from_file_location('copy_check', Path(__file__).resolve().parents[2] / 'bin/copy_check.py')
copy_check = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(copy_check)


def texts(script: str) -> list[str]:
    return [text for _, text in copy_check.script_texts(script)]


class CopyCheckTests(unittest.TestCase):
    def test_a_text_after_a_closing_tag_on_the_same_line_is_read(self) -> None:
        found = texts('const a = <p>Текст</p>; const b = <span>Пожалуйста, нажмите!</span>;\n')
        self.assertIn('Текст', found)
        self.assertIn('Пожалуйста, нажмите!', found)

    def test_a_regular_expression_is_not_a_text_and_a_string_after_it_is(self) -> None:
        found = texts('const sign = /пожалуйста!/i; const done = "Готово";\n')
        self.assertEqual([text for text in found if 'пожалуйста' in text], [])
        self.assertIn('Готово', found)
