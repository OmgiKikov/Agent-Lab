"""A check's result in numbers and what carries over to the next one: the counts every screen shows, the recurring
errors, the second judge's agreement, the answers people gave on verdicts that did not change. Pure functions over
results; a result that judged nothing is no result."""

from . import quotes

UNANSWERED = 'Модель проверки не ответила ни по одному разговору.'


def with_unmeasured(summary: dict, sampled: object) -> dict:
    """A check's counts with «не удалось проверить» counted from its sample: every conversation it took and gave no
    verdict, those Точность's planner put in no topic included. Every screen, the history, the list of agents and the
    summary for management then say the same number as the result's own screen (problems.from_logs). A record without
    its sample keeps its own count."""
    if not isinstance(sampled, int) or not isinstance(summary.get('measured'), int):
        return summary
    return {**summary, 'unmeasured': max(0, sampled - summary['measured'])}


def ensure_answered(results: list[dict], previous: dict | None) -> None:
    """An outage is not a result: when the model answered on no conversation, the check fails, and its previous result
    (previous, the check's own), the scenarios built from it and the history stay. When only some failed, it is a
    result: those conversations are «не удалось проверить». A check that judged no conversation at all is no result
    either: «0 из 0» would replace one that stood."""
    kept = ' Прежний итог сохранён.' if previous else ''
    if not results:
        raise RuntimeError(f'Ни один разговор не попал в тему с критериями.{kept}')
    if all(result['status'] == 'UNMEASURED' for result in results) and any(result.get('error') for result in results):
        raise RuntimeError(f'{UNANSWERED}{kept} Проверьте модель в разделе «Настройки».')


def carry_reviews(previous: dict, results: list[dict]) -> None:
    """A person's decision stays with a verdict that did not change: the same conversation, rule and status, and for
    an error the same words of the agent (quotes.same_finding). Only with frozen rules: extracted anew, the same rule
    id may be another rule."""
    kept = {
        (str(result['dialogueId']), row['ruleId'], row['status']): (row['review'], row.get('agentQuote'))
        for result in previous.get('results') or []
        for row in result.get('rules') or []
        if row.get('review') in ('agree', 'disagree')
    }
    for result in results:
        for row in result['rules']:
            decision, quote = kept.get((str(result['dialogueId']), row['ruleId'], row['status']), (None, None))
            if decision and quotes.same_finding(row['status'], quote, row.get('agentQuote')):
                row['review'] = decision


def summarize(results: list[dict], topics: list[dict], sampled: int | None = None) -> dict:
    """Counts, the second judge's agreement and the recurring violations, most frequent first. With the sample
    (`sampled`), «не удалось проверить» counts every conversation taken without a verdict, those in no topic included
    (with_unmeasured)."""
    measured = [r for r in results if r['status'] != 'UNMEASURED']
    failed = [r for r in results if r['status'] == 'FAIL']
    # One problem = one quote from the source: the same rule restated in several topics is merged.
    patterns: dict[str, dict] = {}
    rules = {rule['id']: (topic, rule) for topic in topics for rule in topic['rules']}
    for result in results:
        for row in result['rules']:
            if row['status'] != 'FAIL' or row['ruleId'] not in rules:
                continue
            topic, rule = rules[row['ruleId']]
            item = patterns.setdefault(
                quotes.normalized(rule['quote']),
                {
                    'ruleId': row['ruleId'],
                    'rule': rule['text'],
                    'quote': rule['quote'],
                    'topics': [],
                    'dialogues': [],
                    'titles': [],
                    'examples': [],
                },
            )
            if topic['title'] not in item['topics']:
                item['topics'].append(topic['title'])
            if result['dialogueId'] in item['dialogues']:
                continue
            item['dialogues'].append(result['dialogueId'])
            if row['title'] and row['title'] not in item['titles']:
                item['titles'].append(row['title'])
            item['examples'].append(
                {
                    'dialogueId': result['dialogueId'],
                    'reason': row['reason'],
                    'agentQuote': row['agentQuote'],
                    'opening': result['opening'],
                }
            )
    for item in patterns.values():
        item['count'] = len(item['dialogues'])
        item['topic'] = ', '.join(item['topics'])
    decided = ('PASS', 'FAIL')
    twice = [r for r in results if r['status'] in decided and (r.get('second') or {}).get('status') in decided]
    second = None
    if twice:
        agree = sum(1 for r in twice if r['second']['status'] == r['status'])
        second = {'model': twice[0]['second']['model'], 'checked': len(twice), 'agree': agree}
    counts = {
        'checked': len(results),
        'measured': len(measured),
        'failed': len(failed),
        'passed': len(measured) - len(failed),
        'unmeasured': len(results) - len(measured),
        'secondJudge': second,
        'patterns': sorted(patterns.values(), key=lambda p: -p['count']),
    }
    return with_unmeasured(counts, sampled)
