import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from lab import registry, store


class RegistryTests(unittest.TestCase):
    def setUp(self) -> None:
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        for mocked in (patch.object(registry, 'ROOT', self.root), patch.object(store, 'DB', self.root / 'lab.sqlite3')):
            mocked.start()
            self.addCleanup(mocked.stop)

    def test_agents_get_readable_unique_ids_in_creation_order(self) -> None:
        first = registry.create('Агент эквайринга', 'СберБизнес · чат поддержки')
        second = registry.create('Агент эквайринга', '')
        self.assertEqual((first['id'], second['id']), ('agent-ekvayringa', 'agent-ekvayringa-2'))
        self.assertEqual(first['name'], 'Агент эквайринга')
        self.assertEqual([a['id'] for a in registry.listed()], ['agent-ekvayringa', 'agent-ekvayringa-2'])
        self.assertEqual(registry.default_id(), 'agent-ekvayringa')
        self.assertEqual(registry.get('agent-ekvayringa-2')['description'], '')
        self.assertIsNone(registry.get('missing'))

    def test_each_agent_reads_and_writes_only_its_own_database(self) -> None:
        first = registry.create('Первый', '')['id']
        second = registry.create('Второй', '')['id']
        with registry.using(first):
            store.save('logs.json', [{'id': '1'}])
        with registry.using(second):
            self.assertIsNone(store.load('logs.json'))
        with registry.using(first):
            self.assertEqual(store.load('logs.json'), [{'id': '1'}])
        self.assertTrue((self.root / 'agents' / first / 'lab.sqlite3').exists())
        self.assertIsNone(store.load('logs.json'))
