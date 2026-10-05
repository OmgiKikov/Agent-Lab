import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from lab import rag, replay, store

DIALOGUE = {
    'id': 'd-1',
    'messages': [
        {'role': 'user', 'content': 'вернуть платёж'},
        {'role': 'assistant', 'content': 'Как принимали оплату?'},
        {'role': 'user', 'content': 'через QR'},
        {'role': 'user', 'content': 'алло'},
    ],
}


class StepsTests(unittest.TestCase):
    def test_a_step_per_customer_message(self) -> None:
        self.assertEqual([s['customer'] for s in replay.steps(DIALOGUE)], ['вернуть платёж', 'через QR', 'алло'])

    def test_history_is_the_log_before_the_message(self) -> None:
        second = replay.steps(DIALOGUE)[1]
        self.assertEqual(
            second['history'],
            [{'role': 'customer', 'text': 'вернуть платёж'}, {'role': 'agent', 'text': 'Как принимали оплату?'}],
        )

    def test_production_reply_is_the_next_agent_message(self) -> None:
        self.assertEqual([s['prodReply'] for s in replay.steps(DIALOGUE)], ['Как принимали оплату?', None, None])


class CriteriaTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        db = patch.object(store, 'DB', Path(directory.name) / 'lab.sqlite3')
        db.start()
        self.addCleanup(db.stop)

    def test_family_prefixes_ids(self) -> None:
        rules = replay.of_family('code', [{'id': 'r1', 'text': 't'}])
        self.assertEqual((rules[0]['id'], rules[0]['family']), ('code:r1', 'code'))

    async def test_without_checks_only_rag_criteria(self) -> None:
        found = await replay.criteria_by_dialogue([DIALOGUE])
        self.assertEqual(found['d-1'], rag.CRITERIA)

    async def test_accuracy_topic_rules_join_for_a_known_dialogue(self) -> None:
        store.save(
            replay.discover.RESULT,
            {
                'topics': [{'id': 't1', 'title': 'Возвраты', 'rules': [{'id': 'r1', 'text': 'про возврат'}]}],
                'results': [{'dialogueId': 'd-1', 'topicId': 't1'}],
            },
        )
        found = await replay.criteria_by_dialogue([DIALOGUE])
        self.assertEqual([r['id'] for r in found['d-1']], ['code:r1', *(r['id'] for r in rag.CRITERIA)])
