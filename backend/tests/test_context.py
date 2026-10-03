import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from lab.context import knowledge, sources


class ContextTests(unittest.TestCase):
    def test_context_resolves_repository_once(self):
        with tempfile.TemporaryDirectory() as folder:
            with patch.object(
                knowledge.agents, 'repo', side_effect=[Path(folder), AssertionError('second lookup')]
            ) as repo:
                self.assertEqual(knowledge.retrieved([{'role': 'agent', 'text': 'Короткий ответ'}]), [])
            self.assertEqual(repo.call_count, 1)

    def test_article_edits_at_same_path_are_visible_to_next_evaluation(self):
        with tempfile.TemporaryDirectory() as folder:
            repo = Path(folder)
            path = repo / knowledge.KB
            path.parent.mkdir(parents=True)
            conversation = [{'role': 'agent', 'text': 'Готово', 'events': [{'tool': 'knowledge', 'article': 'a'}]}]
            with patch.object(knowledge.agents, 'repo', return_value=repo):
                for text in ('Старая статья', 'Новая статья'):
                    path.write_text(json.dumps({'articles': [{'id': 'a', 'title': 'A', 'passages': [text]}]}))
                    self.assertEqual(knowledge.retrieved(conversation)[0]['text'], text)

    def test_ready_answer_edits_at_same_path_are_visible(self):
        with tempfile.TemporaryDirectory() as folder:
            repo = Path(folder)
            path = repo / knowledge.TEXTS[0] / 'answer.py'
            path.parent.mkdir(parents=True)
            with patch.object(knowledge.agents, 'repo', return_value=repo):
                for text in (
                    'Верните оборудование в банк через личный кабинет организации.',
                    'Откройте раздел возвратов в личном кабинете организации.',
                ):
                    path.write_text('ANSWER = ' + repr(text))
                    sources_found = knowledge.retrieved([{'role': 'agent', 'text': text}])
                    self.assertEqual(sources_found[0]['text'], text)

    def test_source_collection_does_not_commit_from_a_worker_thread(self):
        with tempfile.TemporaryDirectory() as folder:
            repo = Path(folder)
            path = repo / 'src' / 'prompt.py'
            path.parent.mkdir()
            prompt = 'Ты ассистент банка. Используй правила ответа клиенту. ' * 30
            path.write_text('PROMPT = ' + repr(prompt))
            with patch.object(sources.store, 'save') as save:
                collected = sources.collect(repo)
            self.assertEqual(collected[0]['content'], prompt.strip())
            self.assertEqual(collected[0]['id'], 's1')
            save.assert_not_called()

    def test_a_folder_without_code_is_named_with_the_place_to_set_it(self):
        with tempfile.TemporaryDirectory() as folder, self.assertRaises(RuntimeError) as refused:
            sources.collect(Path(folder))
        self.assertEqual(
            str(refused.exception),
            f'Нет кода агента в {folder}: укажите папку с кодом в разделе «Агент» и нажмите «Прочитать код».',
        )
