import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from lab import agents
from lab.agents.http import AgentError, HttpAgent, read_reply


class AgentReplyTests(unittest.TestCase):
    def test_reply_and_buttons_are_read_without_coercing_foreign_shapes(self):
        result = read_reply(
            {'message': {'content': {'status_code': '200', 'result': 'Тариф 2%'}}, 'suggestions': [{'text': 'Другой'}]},
            200,
        )
        self.assertTrue(result['ok'])
        self.assertEqual(result['options'], ['Другой'])

    def test_handoff_is_preserved(self):
        result = read_reply({'message': {'content': {'status_code': '202-1', 'reason': 'Передаю оператору'}}}, 200)
        self.assertFalse(result['ok'])
        self.assertEqual(result['status'], '202-1')

    def test_malformed_json_shape_is_an_agent_error(self):
        for value in ([], {}, {'message': []}, {'message': {'content': {'result': ['text']}}}):
            with self.subTest(value=value), self.assertRaises(AgentError):
                read_reply(value, 200)


class ReadinessTests(unittest.TestCase):
    def test_the_agent_from_its_code_is_ready_only_when_its_folder_can_start_it(self):
        with tempfile.TemporaryDirectory() as home, patch.dict(os.environ, {'HOME': home}):
            config = {'name': 'Агент из исходников', 'kind': 'code', 'repo': '~/agent'}
            self.assertFalse(agents.public('local-code', config)['ready'])  # no folder
            (Path(home) / 'agent' / 'local').mkdir(parents=True)
            self.assertFalse(agents.public('local-code', config)['ready'])  # a folder without its start script
            (Path(home) / 'agent' / 'local' / 'run-app.sh').write_text('#!/bin/sh\n')
            self.assertTrue(agents.public('local-code', config)['ready'])

    def test_an_agent_at_an_address_is_ready_when_the_address_is_set(self):
        config = {'name': 'Агент на ИФТ', 'kind': 'http'}
        self.assertFalse(agents.public('prod', config | {'url': ''})['ready'])
        self.assertTrue(agents.public('prod', config | {'url': 'https://ift.example/agent'})['ready'])


class NamesTests(unittest.TestCase):
    def test_the_ways_to_reach_the_agent_have_the_names_of_the_agent_section(self):
        """«Сыграть» said «Агент на ИФТ / Локальный агент / Агент из исходников» for what «Агент» calls «Тестовый
        стенд банка / На этом компьютере / Запуск из кода»: one set everywhere, in words without a developer's slang."""
        ways = agents.configs({'prodUrl': '', 'epk': [], 'repo': '~/agent'})
        named = {key: config['name'] for key, config in ways.items()}
        self.assertEqual(
            named,
            {'prod': 'Тестовый стенд банка', 'local-http': 'На этом компьютере', 'local-code': 'Запуск из кода'},
        )


class MissingAddressTests(unittest.IsolatedAsyncioTestCase):
    async def test_an_agent_without_its_address_names_where_to_set_it(self):
        with self.assertRaises(AgentError) as refused:
            await HttpAgent({'url': '', 'profile': 'prod'}).open()
        self.assertEqual(
            str(refused.exception),
            'Не задан адрес агента на тестовом стенде. Укажите его в разделе «Агент».',
        )
