"""What two saved checks of one check have in common: the same criteria, the same models and instructions of the judge,
the same conversations. Pure functions over saved records, shared by the histories of both checks: no model is called,
nothing is read or stored. Whether the difference
between them says more than chance is statistics.py's.
"""

import hashlib
import json


def fingerprint(value: object) -> str:
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))
    return hashlib.sha256(encoded.encode()).hexdigest()


def dataset_fingerprint(dialogues: list[dict]) -> str:
    """The conversations a check judged, in any order."""
    return fingerprint(sorted(dialogues, key=lambda dialogue: str(dialogue['id'])))


def evaluation_fingerprint(result: dict) -> str:
    """The models that checked the conversations of a result and the versions of the judge's instructions they had
    (roles.Role.version): its own records' main and second models and versions. A second check that failed checked
    nothing: its configured name, unlike the name a model answers with, would make one passing outage read as another
    evaluation. A record from before the versions were kept has none: a check after it is compared with it as judged
    by other instructions, which it may have been."""
    records = result['results']
    seconds = [
        record['second'] for record in records if record.get('second') and record['second'].get('status') != 'ERROR'
    ]
    return fingerprint(
        {
            'main': sorted({record['model'] for record in records if record.get('model')}),
            'fallbackMain': result['model'] if not any(record.get('model') for record in records) else None,
            'second': sorted({second['model'] for second in seconds if second.get('model')}),
            'instructions': sorted(
                {record['judgeVersion'] for record in [*records, *seconds] if record.get('judgeVersion')}
            ),
        }
    )


def comparison(check: dict, previous: dict | None) -> dict:
    """How a saved check stands to the one saved before it: comparable only with the same criteria and models."""
    if previous is None:
        return {'kind': 'first', 'previousId': None, 'reason': 'Это первая сохранённая проверка.'}
    base = {'previousId': previous['id']}
    if check['criteriaFingerprint'] != previous['criteriaFingerprint']:
        return {**base, 'kind': 'incompatible', 'reason': 'Изменились критерии или то, из чего они собраны.'}
    if check['evaluationFingerprint'] != previous['evaluationFingerprint']:
        return {**base, 'kind': 'incompatible', 'reason': 'Изменились модели или инструкции проверки.'}
    if check['datasetFingerprint'] == previous['datasetFingerprint']:
        return {**base, 'kind': 'same-data', 'reason': 'Те же разговоры, критерии и модели. Это повторная оценка.'}
    return {
        **base,
        'kind': 'new-data',
        'reason': 'Другие разговоры при тех же критериях и моделях. Разница не доказывает улучшение агента.',
    }
