"""Точность: the criteria of the agent's code and their record. A criterion stands on an exact quote of the source it
cites (ground); the criteria are kept for the next export (criteria_of), and a finished check is saved with what it
was made of and how it stands to the check saved before it (saved). Pure functions: nothing is read or stored."""

from . import quotes
from .comparison import comparison, dataset_fingerprint, evaluation_fingerprint, fingerprint

# Every criterion the planner wrote cited words the agent's code does not have: there is nothing to check by.
UNGROUNDED = 'Ни один критерий не подтвердился дословной цитатой из кода агента.'


def ground(topics: list[dict], srcs: list[dict]) -> tuple[list[dict], int]:
    """Keep the rules whose quote is found verbatim in the cited source; return them and how many were dropped."""
    by_id = {s['id']: s['content'] for s in srcs}
    dropped, grounded = 0, []
    for t_index, topic in enumerate(topics, 1):
        topic = dict(topic)
        topic['id'] = f't{t_index}'
        kept = []
        for r_index, rule in enumerate(topic.get('rules') or [], 1):
            rule = dict(rule)
            text = by_id.get(rule.get('sourceId'), '')
            if not quotes.found(rule.get('quote', ''), text):
                dropped += 1
                continue
            rule['id'] = f'{topic["id"]}r{r_index}'
            kept.append(rule)
        topic['rules'] = kept
        grounded.append(topic)
    return grounded, dropped


def ensure_grounded(topics: list[dict], previous: dict | None) -> None:
    """Criteria extracted anew, none of them grounded in the agent's code: the check fails before a model is asked
    about any conversation, and the previous result, its criteria and scenarios stay."""
    if not any(topic['rules'] for topic in topics):
        kept = ' Прежний итог сохранён.' if previous else ''
        raise RuntimeError(f'{UNGROUNDED}{kept} Извлеките критерии ещё раз.')


def criteria_fingerprint(result: dict) -> str:
    """The criteria of a check of Точность: its topics, their criteria and the code they were extracted from. Which
    conversations fell into which topic is not part of them: new conversations sorted into the same topics are checked
    by the same criteria."""
    rules = [
        {key: rule.get(key) for key in ('id', 'text', 'quote', 'observation', 'sourceId', 'condition', 'acceptable')}
        for topic in result['topics']
        for rule in topic['rules']
    ]
    return fingerprint(
        {
            'code': sorted(source.get('sha256') or '' for source in result.get('sources') or []),
            'topics': sorted((topic['id'], topic['title']) for topic in result['topics']),
            'rules': sorted(rules, key=lambda rule: (rule['id'] or '', rule['text'] or '')),
        }
    )


def saved(result: dict, dialogues: list[dict], export: dict, previous: dict | None) -> dict:
    """The record of a finished check in the history: the line of the list and the evidence behind it. export: the
    export it was made of, as a result keeps it (storage.exports.line): its file and how many conversations it had."""
    check = {
        'id': result['checkId'],
        'finishedAt': result['finishedAt'],
        'criteriaFingerprint': criteria_fingerprint(result),
        'datasetFingerprint': dataset_fingerprint(dialogues),
        'evaluationFingerprint': evaluation_fingerprint(result),
        'file': export.get('file'),
        'total': export.get('total') or 0,
        'export': named(export),
        'sampled': result['sampled'],
        'summary': {key: result['summary'][key] for key in ('measured', 'passed', 'failed', 'unmeasured')},
        'model': result['model'],
    }
    check['comparison'] = comparison(check, previous)
    return {'check': check, 'result': result, 'dialogues': dialogues}


def named(export: dict) -> dict | None:
    """The export in a saved check's line: its id and its name then. A check of an export never named has none."""
    return {'id': export['id'], 'name': export.get('name')} if export.get('id') else None


def criteria_of(result: dict) -> dict:
    """What of a result the next check keeps after a new export: its topics and criteria, not its conversations."""
    return {
        'topics': [dict(topic, dialogueIds=[]) for topic in result['topics']],
        'rulesSince': result.get('rulesSince'),
        'droppedRules': result.get('droppedRules', 0),
    }
