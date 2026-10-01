import unittest

from lab.agents.http import AgentError, read_reply


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
