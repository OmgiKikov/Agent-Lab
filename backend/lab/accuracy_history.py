"""The saved checks of Точность, like tone of voice's (tone_history): each finished check with its conversations and
result, so that a new export no longer erases it, and its comparison with the check saved before it (history)."""

from . import discover, logs, store
from .history import comparison, dataset_fingerprint, evaluation_fingerprint, fingerprint


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


def saved(result: dict, dialogues: list[dict], file: str | None, total: int, previous: dict | None) -> dict:
    """The record of a finished check in the history: the line of the list and the evidence behind it."""
    check = {
        'id': result['checkId'],
        'finishedAt': result['finishedAt'],
        'criteriaFingerprint': criteria_fingerprint(result),
        'datasetFingerprint': dataset_fingerprint(dialogues),
        'evaluationFingerprint': evaluation_fingerprint(result),
        'file': file,
        'total': total,
        'sampled': result['sampled'],
        'summary': {key: result['summary'][key] for key in ('measured', 'passed', 'failed', 'unmeasured')},
        'model': result['model'],
    }
    check['comparison'] = comparison(check, previous)
    return {'check': check, 'result': result, 'dialogues': dialogues}


def criteria_of(result: dict) -> dict:
    """What of a result the next check keeps after a new export: its topics and criteria, not its conversations."""
    return {
        'topics': [dict(topic, dialogueIds=[]) for topic in result['topics']],
        'rulesSince': result.get('rulesSince'),
        'droppedRules': result.get('droppedRules', 0),
    }


def commit(result: dict, *, new_criteria: bool) -> None:
    """Publish a finished check of Точность together with its record in the history (store.save_audit). Its
    conversations are the export's sample it was made of; an export replaced meanwhile makes the check stale."""
    dialogues = discover.sample(result['sampled'])
    judged = {str(item['dialogueId']) for item in result['results']}
    dialogues = [dialogue for dialogue in dialogues if str(dialogue['id']) in judged]
    if dataset_fingerprint(dialogues) != result['datasetFingerprint']:
        raise ValueError('Разговоры изменились во время проверки. Запустите проверку заново.')
    previous = next(iter(store.code_checks()), None)
    record = saved(result, dialogues, logs.meta().get('file'), store.length(logs.FILE), previous)
    store.save_audit(result, new_criteria=new_criteria, record=record)
