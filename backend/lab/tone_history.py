"""Immutable tone check evidence and conservative comparison metadata; reads never run models."""

import hashlib
import json

from . import logs, store


def fingerprint(value: object) -> str:
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))
    return hashlib.sha256(encoded.encode()).hexdigest()


def criteria_fingerprint(criteria: list[dict], source: dict) -> str:
    return fingerprint({'source': source['sha256'], 'criteria': sorted(criteria, key=lambda rule: rule['id'])})


def comparison(check: dict, previous: dict | None) -> dict:
    if previous is None:
        return {'kind': 'first', 'previousId': None, 'reason': 'Это первая сохранённая проверка.'}
    base = {'previousId': previous['id']}
    if check['criteriaFingerprint'] != previous['criteriaFingerprint']:
        return {**base, 'kind': 'incompatible', 'reason': 'Изменились критерии или правила общения.'}
    if check['evaluationFingerprint'] != previous['evaluationFingerprint']:
        return {**base, 'kind': 'incompatible', 'reason': 'Изменились модели проверки.'}
    if check['datasetFingerprint'] == previous['datasetFingerprint']:
        return {**base, 'kind': 'same-data', 'reason': 'Те же разговоры, критерии и модели. Это повторная оценка.'}
    return {
        **base,
        'kind': 'new-data',
        'reason': 'Другие разговоры при тех же критериях и моделях. Разница не доказывает улучшение агента.',
    }


def snapshot(result: dict, dialogues: list[dict], criteria: list[dict], source: dict) -> dict:
    records = result['results']
    check = {
        'id': result['checkId'],
        'finishedAt': result['finishedAt'],
        'criteriaRevision': result['criteriaRevision'],
        'criteriaFingerprint': result['criteriaFingerprint'],
        'datasetFingerprint': fingerprint(sorted(dialogues, key=lambda dialogue: str(dialogue['id']))),
        'evaluationFingerprint': fingerprint(
            {
                'main': sorted({record['model'] for record in records if record.get('model')}),
                'fallbackMain': result['model'] if not any(record.get('model') for record in records) else None,
                'second': sorted(
                    {record['second']['model'] for record in records if (record.get('second') or {}).get('model')}
                ),
            }
        ),
        'file': logs.meta().get('file'),
        'total': len(logs.load()),
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
