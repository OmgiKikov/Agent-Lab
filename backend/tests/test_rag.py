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


def verdict(rule_id: str, status: str) -> dict:
    return {'ruleId': rule_id, 'rule': '', 'status': status, 'reason': '', 'agentQuote': '', 'title': ''}


def step(index: int, trace: dict | None, verdicts: dict[str, str]) -> dict:
    """A replayed step as replay.py saves it: its trace and the main model's verdict on each criterion."""
    return {
        'index': index,
        'customer': f'реплика {index}',
        'trace': trace,
        'rules': [verdict(rule_id, status) for rule_id, status in verdicts.items()],
    }


ASKED = {'chains': [], 'rag': [{'source': 'idp', 'query': 'q', 'passages': [], 'answer': 'a'}], 'systems': []}
CACHED = {'chains': [], 'rag': [{'source': 'cache', 'query': 'q', 'passages': [], 'answer': 'a'}], 'systems': []}
NOT_ASKED = {'chains': [], 'rag': [], 'systems': []}
MATCH = 'replay:match'


def replayed(*steps: dict) -> list[dict]:
    return [{'dialogueId': 'd-1', 'status': 'PASS', 'steps': list(steps)}]


def criterion(summary: dict, rule_id: str) -> dict:
    return next(row for row in summary['criteria'] if row['id'] == rule_id)


class SummaryTests(unittest.TestCase):
    def test_a_step_answered_from_the_cache_used_the_knowledge_base(self) -> None:
        self.assertEqual(rag.summary(replayed(step(0, CACHED, {})))['called'], 1)

    def test_a_step_without_a_call_is_left_out(self) -> None:
        summary = rag.summary(replayed(step(0, NOT_ASKED, {}), step(1, None, {})))
        self.assertEqual((summary['steps'], summary['called']), (2, 0))

    def test_a_criterion_counts_pass_fail_and_unknown_apart(self) -> None:
        summary = rag.summary(
            replayed(
                step(0, ASKED, {'rag:relevant': 'PASS'}),
                step(1, ASKED, {'rag:relevant': 'FAIL'}),
                step(2, ASKED, {'rag:relevant': 'UNKNOWN'}),
                step(3, ASKED, {'rag:relevant': 'NOT_APPLICABLE'}),
            )
        )
        found = criterion(summary, 'rag:relevant')
        self.assertEqual((found['pass'], found['fail'], found['unknown']), (1, 1, 1))

    def test_failed_points_to_the_steps_that_failed_the_criterion(self) -> None:
        summary = rag.summary(replayed(step(0, ASKED, {'rag:query': 'PASS'}), step(1, ASKED, {'rag:query': 'FAIL'})))
        self.assertEqual(criterion(summary, 'rag:query')['failed'], [{'dialogueId': 'd-1', 'step': 1}])

    def test_every_criterion_is_listed_in_order_with_its_name(self) -> None:
        summary = rag.summary([])
        self.assertEqual(
            [(row['id'], row['name']) for row in summary['criteria']],
            [(rule['id'], rule['name']) for rule in rag.CRITERIA],
        )

    def test_the_match_with_production_is_counted_on_steps_that_used_the_knowledge_base(self) -> None:
        summary = rag.summary(
            replayed(
                step(0, ASKED, {MATCH: 'PASS'}),
                step(1, ASKED, {MATCH: 'FAIL'}),
                step(2, ASKED, {MATCH: 'UNKNOWN'}),
                step(3, NOT_ASKED, {MATCH: 'FAIL'}),
            )
        )
        self.assertEqual(
            summary['match'],
            {'same': 1, 'different': 1, 'unknown': 1, 'differentSteps': [{'dialogueId': 'd-1', 'step': 1}]},
        )

    def test_an_empty_replay_has_nothing_counted(self) -> None:
        self.assertEqual(rag.summary([])['match'], {'same': 0, 'different': 0, 'unknown': 0, 'differentSteps': []})

    def test_a_replay_without_calls_has_every_criterion_at_zero(self) -> None:
        verdicts = {rule['id']: 'FAIL' for rule in rag.CRITERIA}
        summary = rag.summary(replayed(step(0, NOT_ASKED, verdicts), step(1, NOT_ASKED, verdicts)))
        counts = [
            {key: value for key, value in row.items() if key not in ('id', 'name')} for row in summary['criteria']
        ]
        self.assertEqual(counts, [{'pass': 0, 'fail': 0, 'unknown': 0, 'failed': []}] * len(rag.CRITERIA))

    def test_the_second_models_verdicts_do_not_count(self) -> None:
        second = {'model': 'm', 'status': 'FAIL', 'rules': [verdict('rag:query', 'FAIL')]}
        with_second = {**step(0, ASKED, {'rag:query': 'PASS'}), 'second': second}
        summary = rag.summary(replayed(with_second))
        self.assertEqual(criterion(summary, 'rag:query')['failed'], [])
