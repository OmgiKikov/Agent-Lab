"""The Lab's own instruments (python -m lab.eval): how often people agree with the judge, per role, version of its
instructions and check, from the answers they gave on its verdicts; and how the calls to the models went."""

import json
import unittest

import support

import lab.eval as lab_eval
from lab import storage
from lab.domain import instruments
from lab.domain.statistics import wilson
from lab.flows import accuracy, answers, evaluation
from lab.storage import registry


def verdict(rule_id: str, status: str, quote: str = '') -> dict:
    return {'ruleId': rule_id, 'status': status, 'reason': 'Причина', 'agentQuote': quote}


def result(check_id: str, review: str | None = None) -> dict:
    """A result of Точность: one conversation, an error by r1 (answered `review` when given) and none by r2."""
    first = dict(verdict('r1', 'FAIL', 'звоните'), **({'review': review} if review else {}))
    return {
        'checkId': check_id,
        'finishedAt': f'at-{check_id}',
        'sampled': 1,
        'model': 'model-a',
        'summary': {'measured': 1, 'passed': 0, 'failed': 1, 'unmeasured': 0},
        'topics': [{'id': 't1', 'title': 'Тема', 'rules': []}],
        'results': [
            {
                'dialogueId': 'd1',
                'topicId': 't1',
                'status': 'FAIL',
                'judgeVersion': 'v1',
                'rules': [first, verdict('r2', 'PASS')],
            }
        ],
    }


def published(check_id: str, review: str | None = None) -> None:
    found = result(check_id, review)
    accuracy.publish(found, {'check': {'id': check_id, 'finishedAt': found['finishedAt']}}, new_criteria=False)


class AgreementTests(unittest.TestCase):
    def test_answers_are_counted_per_role_version_and_check(self) -> None:
        answered = [
            ('judge.log', 'v1', 'tone', 'FAIL', 'agree'),
            ('judge.log', 'v1', 'tone', 'FAIL', 'disagree'),
            ('judge.log', 'v1', 'tone', 'PASS', 'agree'),
            ('judge.log', 'v2', 'tone', 'FAIL', 'agree'),
            ('judge.run', 'v1', 'code', 'PASS', 'disagree'),
        ]
        keys = ('role', 'version', 'check', 'status', 'decision')
        rows = instruments.agreement(dict(zip(keys, answer, strict=True)) for answer in answered)
        self.assertEqual(
            [(row['role'], row['version'], row['check']) for row in rows],
            [('judge.log', 'v1', 'tone'), ('judge.log', 'v2', 'tone'), ('judge.run', 'v1', 'code')],
        )
        first = rows[0]
        self.assertEqual((first['answered'], first['agreed'], first['share']), (3, 2, 2 / 3))
        self.assertEqual(first['errors'], {'confirmed': 1, 'answered': 2})
        self.assertEqual(first['clean'], {'confirmed': 1, 'answered': 1})
        self.assertEqual(first['interval'], wilson(2, 3))
        self.assertTrue(first['few'])

    def test_where_a_share_may_lie_is_wide_with_few_answers_and_never_beyond_the_ends(self) -> None:
        low, high = wilson(37, 42)
        self.assertEqual((round(low, 2), round(high, 2)), (0.75, 0.95))
        self.assertEqual(wilson(5, 5)[1], 1.0)
        self.assertEqual(wilson(0, 5)[0], 0.0)
        self.assertGreater(wilson(1, 2)[1] - wilson(1, 2)[0], wilson(50, 100)[1] - wilson(50, 100)[0])
        self.assertIsNone(wilson(0, 0))

    def test_calls_are_counted_per_role_version_and_model(self) -> None:
        calls = [
            {'role': 'judge.log', 'version': 'v1', 'model': 'm', 'outcome': 'answered', 'ms': 100, 'inputTokens': 10},
            {'role': 'judge.log', 'version': 'v1', 'model': 'm', 'outcome': 'unusable', 'ms': 300, 'cost': 0.5},
            {'role': 'judge.log', 'version': 'v1', 'model': 'm', 'outcome': 'answered', 'ms': 200, 'outputTokens': 4},
            {'role': 'planner', 'version': 'p1', 'model': 'm', 'outcome': 'failed', 'ms': 50},
        ]
        first, second = instruments.usage(calls)
        self.assertEqual((first['role'], first['calls'], first['medianMs']), ('judge.log', 3, 200.0))
        self.assertEqual(first['outcomes'], {'answered': 2, 'unusable': 1, 'refused': 0, 'failed': 0})
        self.assertEqual((first['inputTokens'], first['outputTokens'], first['cost'], first['priced']), (10, 4, 0.5, 1))
        self.assertEqual((second['role'], second['cost']), ('planner', None))


class AnsweredTests(unittest.TestCase):
    def setUp(self) -> None:
        support.lab(self)

    def test_only_a_persons_own_answers_on_verdicts_measure_the_judge(self) -> None:
        published('c1')
        answers.on_log('code', 'd1', 'r1', 'agree')
        answers.on_log('code', 'd1', 'r2', 'disagree')
        answers.on_log('code', 'd1', 'r2', None)  # taken back: no answer
        published('c2', review='agree')  # carried by the Lab: the person's answer was on c1's verdict
        item = {'cardId': 'card-1', 'status': 'FAIL', 'judgeVersion': 'v9', 'rules': [verdict('r1', 'FAIL', 'x')]}
        storage.runs.create({'id': 'run-1', 'status': 'done', 'items': [item]})
        answers.on_run('run-1', 0, 'disagree', 'r1')
        answers.on_run('run-1', 0, 'agree')  # on the whole conversation: on no verdict of the judge
        self.assertEqual(
            evaluation.answered(),
            [
                {'role': 'judge.log', 'version': 'v1', 'check': 'code', 'status': 'FAIL', 'decision': 'agree'},
                {'role': 'judge.run', 'version': 'v9', 'check': 'code', 'status': 'FAIL', 'decision': 'disagree'},
            ],
        )


class ReportTests(unittest.TestCase):
    def setUp(self) -> None:
        support.lab(self)

    def test_the_judge_is_one_instrument_whatever_the_agent(self) -> None:
        for name in ('Агент эквайринга', 'Агент кредитов'):
            with registry.using(registry.create(name)['id']):
                published('c1')
                answers.on_log('code', 'd1', 'r1', 'agree')
        found = json.loads(lab_eval.report('judge', as_json=True))
        self.assertEqual(found['agents'], ['Агент эквайринга', 'Агент кредитов'])
        self.assertEqual(
            [(row['role'], row['answered'], row['agreed']) for row in found['rows']], [('judge.log', 2, 2)]
        )
        text = lab_eval.report('judge')
        self.assertIn('judge.log · версия v1 · Точность', text)
        self.assertIn('Ответили на 2\u00a0вердикта, согласны с\u00a02: 100%', text)
        self.assertIn('Ответов меньше 30: вывод предварительный.', text)
        one = json.loads(lab_eval.report('judge', 'agent-ekvayringa', as_json=True))
        self.assertEqual((one['agents'], one['rows'][0]['answered']), (['Агент эквайринга'], 1))
        with self.assertRaisesRegex(ValueError, 'Нет агента «nope»'):
            lab_eval.report('judge', 'nope')

    def test_without_answers_or_calls_the_reports_say_so(self) -> None:
        self.assertIn('Люди ещё не ответили ни на один вердикт судьи.', lab_eval.report('judge'))
        self.assertIn('Журнал вызовов пуст.', lab_eval.report('calls'))
        self.assertFalse(storage.db.default_database().exists())  # a report never creates a database


if __name__ == '__main__':
    unittest.main()
