import unittest

from lab import rag

TRACE = {
    'traceId': 't',
    'chains': [
        {
            'name': 'Цепочка IDP',
            'messages': [{'role': 'system', 'content': 'длинный промпт'}],
            'output': '{"output": "как вернуть платёж"}',
            'seconds': 1.0,
        }
    ],
    'rag': [
        {
            'query': 'как вернуть платёж',
            'filter': '*Эквайринг*',
            'systemPrompt': 'Ответь по {document}',
            'passages': [
                {
                    'article': 'a1',
                    'passage': 2,
                    'text': 'Возврат оформляют в разделе «Операции».',
                    'retrieval': 0.7,
                    'reranker': 0.9,
                }
            ],
            'answer': 'Оформите возврат в разделе «Операции».',
            'reason': None,
            'source': 'idp',
            'status': 'ok',
            'request': {'message': {}},
        }
    ],
    'systems': [{'tool': 'getLkkTariff', 'arguments': {}, 'status': 'stubbed', 'response': {'tariff': '2%'}}],
}


class RagTests(unittest.TestCase):
    def test_every_criterion_is_of_the_rag_family(self) -> None:
        self.assertTrue(all(rule['family'] == 'rag' and rule['id'].startswith('rag:') for rule in rag.CRITERIA))

    def test_knowledge_base_called(self) -> None:
        self.assertTrue(rag.called(TRACE))
        self.assertFalse(rag.called({**TRACE, 'rag': []}))
        self.assertFalse(rag.called(None))

    def test_evidence_holds_query_passages_and_answer(self) -> None:
        evidence = rag.evidence(TRACE)
        for text in ('как вернуть платёж', 'Возврат оформляют в разделе «Операции».', 'Оформите возврат'):
            self.assertIn(text, evidence)

    def test_judge_sees_chain_outputs_without_prompts(self) -> None:
        shown = rag.for_judge(TRACE)
        self.assertEqual(shown['chains'], [{'name': 'Цепочка IDP', 'output': '{"output": "как вернуть платёж"}'}])
        self.assertNotIn('systemPrompt', shown['rag'][0])
        self.assertEqual(shown['systems'], [{'tool': 'getLkkTariff', 'arguments': {}, 'response': {'tariff': '2%'}}])

    def test_tools_are_the_system_names(self) -> None:
        self.assertEqual(rag.tools(TRACE), 'getLkkTariff')

    def test_skipped_criterion_is_not_applicable(self) -> None:
        row = rag.skipped(rag.CRITERIA[0])
        self.assertEqual((row['ruleId'], row['status']), ('rag:query', 'NOT_APPLICABLE'))


class StandTraceTests(unittest.TestCase):
    def test_the_judge_sees_where_an_answer_came_from_and_whether_the_call_ended(self) -> None:
        call = rag.for_judge(TRACE)['rag'][0]
        self.assertEqual((call['source'], call['status']), ('idp', 'ok'))

    def test_the_judge_does_not_get_the_request_with_its_prompts(self) -> None:
        self.assertNotIn('request', rag.for_judge(TRACE)['rag'][0])

    def test_the_judge_sees_the_bank_systems_data(self) -> None:
        self.assertEqual(rag.for_judge(TRACE)['systems'][0]['response'], {'tariff': '2%'})

    def test_an_answer_from_the_cache_is_a_knowledge_base_call(self) -> None:
        cached = {'rag': [{'source': 'cache', 'query': 'q', 'passages': [], 'answer': 'a'}]}
        self.assertTrue(rag.called(cached))
