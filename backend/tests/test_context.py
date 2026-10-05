import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from lab import store
from lab.agents import knowledge, sources


class ContextTests(unittest.TestCase):
    def test_article_edits_at_same_path_are_visible_to_next_evaluation(self):
        with tempfile.TemporaryDirectory() as folder:
            repo = Path(folder)
            path = repo / knowledge.KB
            path.parent.mkdir(parents=True)
            conversation = [{'role': 'agent', 'text': 'Готово', 'events': [{'tool': 'knowledge', 'article': 'a'}]}]
            for text in ('Старая статья', 'Новая статья'):
                path.write_text(json.dumps({'articles': [{'id': 'a', 'title': 'A', 'passages': [text]}]}))
                self.assertEqual(knowledge.retrieved(repo, conversation)[0]['text'], text)

    def test_ready_answer_edits_at_same_path_are_visible(self):
        with tempfile.TemporaryDirectory() as folder:
            repo = Path(folder)
            path = repo / knowledge.TEXTS[0] / 'answer.py'
            path.parent.mkdir(parents=True)
            for text in (
                'Верните оборудование в банк через личный кабинет организации.',
                'Откройте раздел возвратов в личном кабинете организации.',
            ):
                path.write_text('ANSWER = ' + repr(text))
                sources_found = knowledge.retrieved(repo, [{'role': 'agent', 'text': text}])
                self.assertEqual(sources_found[0]['text'], text)

    def test_source_collection_does_not_commit_from_a_worker_thread(self):
        with tempfile.TemporaryDirectory() as folder:
            repo = Path(folder)
            path = repo / 'src' / 'prompt.py'
            path.parent.mkdir()
            prompt = 'Ты ассистент банка. Используй правила ответа клиенту. ' * 30
            path.write_text('PROMPT = ' + repr(prompt))
            with patch.object(store, 'save') as save:
                collected, over_budget = sources.collect(repo)
            self.assertEqual(over_budget, [])
            self.assertEqual(collected[0]['content'], prompt.strip())
            self.assertEqual(collected[0]['id'], 's1')
            save.assert_not_called()

    def test_only_the_agents_tests_are_left_out_of_its_code(self):
        prompt = 'Ты ассистент банка. Используй правила ответа клиенту. '
        files = {
            'src/agent/prompts.py': True,
            'src/agent/latest.py': True,
            'src/agent/contest.py': True,
            'src/attestation/rules.py': True,
            'src/agent/test_prompts.py': False,
            'src/agent/prompts_test.py': False,
            'src/agent/conftest.py': False,
            'src/tests/fixtures.py': False,
            'src/agent/unit_tests/cases.py': False,
            'src/test/cases.py': False,
        }
        with tempfile.TemporaryDirectory(suffix='_tests') as folder:  # where the repository lives names nothing
            repo = Path(folder)
            for number, name in enumerate(files):
                path = repo / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(f'PROMPT = {(prompt + str(number) + " ") * 12!r}')
            collected, _ = sources.collect(repo)
        read = {source['origin'].split(':')[0] for source in collected}
        self.assertEqual(read, {name for name, agent in files.items() if agent})

    def test_prompts_over_the_planners_budget_are_named(self):
        with tempfile.TemporaryDirectory() as folder:
            repo = Path(folder)
            (repo / 'src').mkdir()
            for name, size in (('a', 25000), ('b', 30000), ('c', 20000)):
                text = ('Ты ассистент банка. Используй правила ответа клиенту ' + name + '. ') * 600
                (repo / 'src' / f'{name}.py').write_text(f'PROMPT = {text[:size]!r}')
            collected, over_budget = sources.collect(repo)
        self.assertEqual(sorted(source['origin'] for source in collected), ['src/a.py:1', 'src/b.py:1'])
        self.assertEqual(over_budget, ['src/c.py:1'])
        self.assertLessEqual(sum(len(source['content']) for source in collected), sources.MAX_TOTAL)

    def test_a_folder_without_code_is_named_with_the_place_to_set_it(self):
        with tempfile.TemporaryDirectory() as folder, self.assertRaises(RuntimeError) as refused:
            sources.collect(Path(folder))
        self.assertEqual(
            str(refused.exception),
            f'В папке {folder} нет кода агента. Укажите папку с кодом в разделе «Агент».',
        )
