import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from lab import llm, match, rag, replay, store
from lab.agents import AgentError
from lab.judge import Verdict

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


class StatusTests(unittest.TestCase):
    def test_a_failed_step_fails_the_dialogue(self) -> None:
        self.assertEqual(replay.dialogue_status([{'status': 'PASS'}, {'status': 'FAIL'}]), 'FAIL')

    def test_a_passed_step_passes_the_dialogue_beside_unmeasured_ones(self) -> None:
        self.assertEqual(replay.dialogue_status([{'status': 'UNMEASURED'}, {'status': 'PASS'}]), 'PASS')

    def test_no_measured_step_leaves_the_dialogue_unmeasured(self) -> None:
        self.assertEqual(replay.dialogue_status([{'status': 'UNMEASURED'}, {}]), 'UNMEASURED')


def row(rule_id: str, status: str) -> dict:
    return {'ruleId': rule_id, 'rule': '', 'status': status, 'reason': '', 'agentQuote': '', 'title': ''}


class MetricTests(unittest.TestCase):
    def test_a_family_counts_steps_and_one_failed_rule_fails_its_step(self) -> None:
        played = [
            {
                'steps': [
                    {'rules': [row('rag:1', 'PASS'), row('rag:2', 'FAIL'), row('tone:1', 'PASS')]},
                    {'rules': [row('rag:1', 'PASS'), row('rag:2', 'NOT_APPLICABLE')]},
                    {'rules': [row('rag:1', 'UNKNOWN')]},
                ]
            }
        ]
        found = replay.metric(played)
        self.assertEqual(
            {family: (score['pass'], score['fail']) for family, score in found.items()},
            {'tone': (1, 0), 'code': (0, 0), 'rag': (1, 1)},
        )

    def test_the_match_with_production_changes_no_familys_counts(self) -> None:
        rules = [row('rag:1', 'PASS'), row('tone:1', 'PASS')]
        without = replay.metric([{'steps': [{'rules': rules}]}])
        with_failed_match = replay.metric([{'steps': [{'rules': [*rules, row(match.CRITERION['id'], 'FAIL')]}]}])
        self.assertEqual(with_failed_match, without)


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

    async def test_without_checks_only_rag_criteria_and_the_match(self) -> None:
        found = await replay.criteria_by_dialogue([DIALOGUE])
        self.assertEqual(found['d-1'], [*rag.CRITERIA, match.CRITERION])

    async def test_accuracy_topic_rules_join_for_a_known_dialogue(self) -> None:
        store.save(
            replay.discover.RESULT,
            {
                'topics': [{'id': 't1', 'title': 'Возвраты', 'rules': [{'id': 'r1', 'text': 'про возврат'}]}],
                'results': [{'dialogueId': 'd-1', 'topicId': 't1'}],
            },
        )
        found = await replay.criteria_by_dialogue([DIALOGUE])
        self.assertEqual(
            [r['id'] for r in found['d-1']], ['code:r1', *(r['id'] for r in rag.CRITERIA), match.CRITERION['id']]
        )


TRACE = {'traceId': 't', 'chains': [], 'rag': [{'query': 'q', 'passages': [], 'answer': 'a'}], 'systems': []}


class FakeAgent:
    """A local agent that answers every message, or fails on the ones it is told to."""

    mocked = True
    version = 'v1'

    def __init__(self, failing: tuple[str, ...] = (), trace: dict | None = TRACE, traced: int | None = None) -> None:
        """traced: how many first turns come with the trace; None — every one."""
        self.failing, self.trace, self.traced, self.heard = failing, trace, traced, []

    async def open(self) -> None:
        pass

    async def close(self) -> None:
        pass

    async def say(
        self, conversation_id: str, text: str, world: dict | None = None, history: list | None = None
    ) -> dict:
        self.heard.append((conversation_id, text, len(history or [])))
        if text in self.failing:
            raise AgentError('Нет связи с агентом.')
        return {
            'text': f'ответ на {text}',
            'status': '200',
            'ok': True,
            'options': [],
            'seconds': 0.1,
            'events': [],
            'trace': self.trace if self.traced is None or len(self.heard) <= self.traced else None,
        }


async def passing_judge(rules: list[dict], step: dict, endpoint=None) -> Verdict:
    rows = [
        {'ruleId': r['id'], 'rule': r['text'], 'status': 'PASS', 'reason': 'ok', 'agentQuote': 'x', 'title': ''}
        for r in rules
    ]
    return Verdict(rows, 'PASS', 'judge-model')


async def silent_judge(rules: list[dict], step: dict, endpoint=None) -> Verdict:
    raise llm.ModelError('Модель не ответила.')


class RunTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        db = patch.object(store, 'DB', Path(directory.name) / 'lab.sqlite3')
        db.start()
        self.addCleanup(db.stop)
        store.save(replay.logs.FILE, [DIALOGUE])

    async def play(self, agent: FakeAgent, verdict=passing_judge) -> dict:
        return await replay.run('local', 5, lambda **_: None, create=lambda _key: agent, verdict=verdict)

    async def test_steps_of_a_dialogue_share_one_conversation(self) -> None:
        agent = FakeAgent()
        await self.play(agent)
        self.assertEqual(len({conversation for conversation, _, _ in agent.heard}), 1)
        self.assertEqual([size for _, _, size in agent.heard], [0, 2, 3])

    async def test_result_is_saved_with_verdicts_per_step(self) -> None:
        result = await self.play(FakeAgent())
        self.assertEqual(store.load(replay.RESULT)['id'], result['id'])
        dialogue = result['dialogues'][0]
        self.assertEqual(dialogue['status'], 'PASS')
        self.assertEqual(dialogue['steps'][0]['reply']['text'], 'ответ на вернуть платёж')
        self.assertEqual(result['metric']['rag']['pass'], 3)

    async def test_summary_is_saved_beside_the_result(self) -> None:
        result = await self.play(FakeAgent())
        self.assertEqual(store.load(replay.REPLAY_SUMMARY), {'id': result['id'], 'finishedAt': result['finishedAt']})

    async def test_summary_reads_only_its_own_document(self) -> None:
        store.save(replay.REPLAY_SUMMARY, {'id': 'r-1', 'finishedAt': '2026-10-05T10:00:00.000+00:00'})
        self.assertEqual(replay.summary(), {'id': 'r-1', 'finishedAt': '2026-10-05T10:00:00.000+00:00'})

    async def test_agent_failure_leaves_the_step_unmeasured(self) -> None:
        result = await self.play(FakeAgent(failing=('через QR',)))
        step = result['dialogues'][0]['steps'][1]
        self.assertEqual((step['status'], step['error']), ('UNMEASURED', 'Нет связи с агентом.'))
        self.assertEqual(result['dialogues'][0]['status'], 'PASS')

    async def test_judge_failure_keeps_the_rows_unknown_and_the_step_unmeasured(self) -> None:
        store.save(
            replay.discover.RESULT,
            {
                'topics': [{'id': 't1', 'title': 'Возвраты', 'rules': [{'id': 'r1', 'text': 'про возврат'}]}],
                'results': [{'dialogueId': 'd-1', 'topicId': 't1'}],
            },
        )
        result = await self.play(FakeAgent(trace={**TRACE, 'rag': []}), verdict=silent_judge)
        step = result['dialogues'][0]['steps'][0]
        self.assertEqual(
            (step['status'], step['error'], {r['ruleId']: r['status'] for r in step['rules']}),
            (
                'UNMEASURED',
                'Модель не ответила.',
                {
                    'code:r1': 'UNKNOWN',
                    **{r['id']: 'NOT_APPLICABLE' for r in rag.CRITERIA},
                    match.CRITERION['id']: 'UNKNOWN',
                },
            ),
        )

    async def test_a_reply_unlike_production_fails_no_step(self) -> None:
        async def unlike_production(rules: list[dict], step: dict, endpoint=None) -> Verdict:
            rows = [
                {
                    'ruleId': r['id'],
                    'rule': r['text'],
                    'status': 'FAIL' if r['id'] == match.CRITERION['id'] else 'PASS',
                    'reason': 'ok',
                    'agentQuote': 'x',
                    'title': '',
                }
                for r in rules
            ]
            return Verdict(rows, 'PASS', 'judge-model')

        result = await self.play(FakeAgent(), verdict=unlike_production)
        self.assertEqual(result['dialogues'][0]['steps'][0]['status'], 'PASS')

    async def test_the_match_does_not_apply_without_a_production_reply(self) -> None:
        result = await self.play(FakeAgent())
        rows = result['dialogues'][0]['steps'][1]['rules']
        self.assertEqual(next(r['status'] for r in rows if r['ruleId'] == match.CRITERION['id']), 'NOT_APPLICABLE')

    async def test_rag_criteria_are_not_applicable_without_a_knowledge_base_call(self) -> None:
        result = await self.play(FakeAgent(trace={**TRACE, 'rag': []}))
        rows = result['dialogues'][0]['steps'][0]['rules']
        self.assertTrue(all(r['status'] == 'NOT_APPLICABLE' for r in rows if r['ruleId'].startswith('rag:')))

    async def test_agent_without_trace_stops_the_replay(self) -> None:
        with self.assertRaisesRegex(RuntimeError, 'трейс'):
            await self.play(FakeAgent(trace=None))

    async def test_a_later_step_without_trace_is_unmeasured_and_the_replay_goes_on(self) -> None:
        result = await self.play(FakeAgent(traced=1))
        steps = result['dialogues'][0]['steps']
        self.assertEqual(
            [(step['status'], step.get('error')) for step in steps],
            [('PASS', None), ('UNMEASURED', replay.STEP_WITHOUT_TRACE), ('UNMEASURED', replay.STEP_WITHOUT_TRACE)],
        )

    async def test_remote_agent_is_refused(self) -> None:
        agent = FakeAgent()
        agent.mocked = False
        with self.assertRaisesRegex(RuntimeError, 'локальн'):
            await self.play(agent)
