"""What two saved checks of one check have in common, and whether the difference between them says more than chance.
Pure functions over saved records, shared by the histories of both checks (tone_history, accuracy_history): no model is
called, nothing is read or stored (docs/superpowers/specs/2026-10-04-was-is-design.md, section 3)."""

import hashlib
import json
from math import comb

# Below this many conversations where a criterion could be checked, on either side, a share says little: the same
# threshold as «Проверено мало разговоров: вывод предварительный» (frontend/src/product/Trust.tsx).
FEW = 30
# A difference is called beyond chance when Fisher's exact test (two-sided) gives a p-value below this.
LEVEL = 0.05


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


def with_unmeasured(summary: dict, sampled: object) -> dict:
    """A check's counts with «не удалось проверить» counted from its sample: every conversation it took and gave no
    verdict, those Точность's planner put in no topic included. Every screen, the history, the list of agents and the
    summary for management then say the same number as the result's own screen (problems.from_logs). A record without
    its sample keeps its own count."""
    if not isinstance(sampled, int) or not isinstance(summary.get('measured'), int):
        return summary
    return {**summary, 'unmeasured': max(0, sampled - summary['measured'])}


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


def fisher(a: int, b: int, c: int, d: int) -> float:
    """Fisher's exact test, two-sided, of the table [[a, b], [c, d]]: errors and checked-without-errors before (a, b)
    and now (c, d). The probability, under the same share of errors on both sides, of a split at least as uneven."""
    row, column, total = a + b, a + c, a + b + c + d
    if not total or not row or row == total or not column or column == total:
        return 1.0

    def probability(x: int) -> float:
        return comb(column, x) * comb(total - column, row - x) / comb(total, row)

    observed = probability(a)
    low, high = max(0, row - (total - column)), min(row, column)
    # The tables no more probable than the one observed; the tolerance absorbs rounding in the comparison.
    return min(1.0, sum(p for p in map(probability, range(low, high + 1)) if p <= observed * (1 + 1e-7)))


def verdict(before: dict | None, now: dict | None) -> tuple[str | None, str | None]:
    """What a person may read into a share of errors before and now ({failed, measured} each), and which way it went
    — a fact about the share, not a judgement of the agent: few conversations say nothing more; otherwise the
    difference is beyond chance or within it (Fisher, LEVEL), or there is none."""
    if not before or not now or not before['measured'] or not now['measured']:
        return None, None
    then, current = before['failed'] / before['measured'], now['failed'] / now['measured']
    direction = 'same' if current == then else 'fewer' if current < then else 'more'
    if min(before['measured'], now['measured']) < FEW:
        return 'few', direction
    if direction == 'same':
        return 'same', direction
    p = fisher(before['failed'], before['measured'] - before['failed'], now['failed'], now['measured'] - now['failed'])
    return ('beyond-chance' if p < LEVEL else 'within-chance'), direction
