import unittest

from lab import match


def row(rule_id: str, status: str) -> dict:
    return {'ruleId': rule_id, 'rule': '', 'status': status, 'reason': '', 'agentQuote': '', 'title': ''}


class CountedTests(unittest.TestCase):
    def test_the_match_with_production_counts_in_no_status(self) -> None:
        rows = [row('rag:query', 'PASS'), row(match.CRITERION['id'], 'FAIL')]
        self.assertEqual(match.counted(rows), [row('rag:query', 'PASS')])


class SkippedTests(unittest.TestCase):
    def test_without_a_production_reply_the_match_does_not_apply(self) -> None:
        self.assertEqual(
            (match.skipped()['ruleId'], match.skipped()['status']), (match.CRITERION['id'], 'NOT_APPLICABLE')
        )
