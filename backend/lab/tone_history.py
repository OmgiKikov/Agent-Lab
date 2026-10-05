"""Immutable tone check evidence and conservative comparison metadata; reads never run models."""

from . import logs, store
from .history import comparison, dataset_fingerprint, evaluation_fingerprint, fingerprint


def criteria_fingerprint(criteria: list[dict], source: dict) -> str:
    return fingerprint({'source': source['sha256'], 'criteria': sorted(criteria, key=lambda rule: rule['id'])})


def snapshot(result: dict, dialogues: list[dict], criteria: list[dict], source: dict) -> dict:
    check = {
        'id': result['checkId'],
        'finishedAt': result['finishedAt'],
        'criteriaRevision': result['criteriaRevision'],
        'criteriaFingerprint': result['criteriaFingerprint'],
        'datasetFingerprint': dataset_fingerprint(dialogues),
        'evaluationFingerprint': evaluation_fingerprint(result),
        'file': logs.meta().get('file'),
        'total': store.length(logs.FILE),
        'sampled': result['sampled'],
        'summary': {key: result['summary'][key] for key in ('measured', 'passed', 'failed', 'unmeasured')},
        'model': result['model'],
    }
    previous = store.tone_checks()
    check['comparison'] = comparison(check, previous[0] if previous else None)
    return {
        'check': check,
        'result': result,
        'dialogues': dialogues,
        'criteria': criteria,
        'policy': {'name': source.get('name') or source['origin'], 'content': source['content']},
        'reviewSemantics': 'at-completion',
    }
