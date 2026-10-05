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
            'status': 200,
        }
    ],
    'systems': [{'tool': 'getLkkTariff', 'arguments': {}, 'status': 200}],
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
        self.assertEqual(shown['systems'], [{'tool': 'getLkkTariff', 'arguments': {}}])

    def test_tools_are_the_system_names(self) -> None:
        self.assertEqual(rag.tools(TRACE), 'getLkkTariff')

    def test_skipped_criterion_is_not_applicable(self) -> None:
        row = rag.skipped(rag.CRITERIA[0])
        self.assertEqual((row['ruleId'], row['status']), ('rag:query', 'NOT_APPLICABLE'))
