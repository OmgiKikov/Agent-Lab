"""Whether the difference between two shares of errors says more than chance: a fact about the shares, not a judgement
of the agent."""

from math import comb, sqrt

# Below this many conversations where a criterion could be checked, on either side, a share says little: the same
# threshold as «Проверено мало разговоров: вывод предварительный» (frontend/src/product/Trust.tsx).
FEW = 30
# A difference is called beyond chance when Fisher's exact test (two-sided) gives a p-value below this.
LEVEL = 0.05


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


def wilson(hits: int, total: int, z: float = 1.96) -> tuple[float, float] | None:
    """Where a share hits/total may lie beyond these cases, 95% of the time (Wilson's score interval): honest with few
    cases and at 0% or 100%, unlike the share ± its error. None without a case."""
    if not total:
        return None
    share, square = hits / total, z * z
    centre = (share + square / (2 * total)) / (1 + square / total)
    margin = z * sqrt(share * (1 - share) / total + square / (4 * total * total)) / (1 + square / total)
    return max(0.0, centre - margin), min(1.0, centre + margin)


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


def mcnemar(fixed: int, broken: int) -> float:
    """McNemar's exact test, two-sided, of paired verdicts: the same conversations with an error before and not now
    (fixed), and the other way round (broken). The probability, were the two equally likely, of a split of these
    changes at least as uneven: the conversations that did not change say nothing about the difference."""
    changed = fixed + broken
    if not changed:
        return 1.0
    tail = sum(comb(changed, k) for k in range(min(fixed, broken) + 1))
    return min(1.0, 2 * tail / 2**changed)


def paired(fixed: int, broken: int, pairs: int) -> tuple[str | None, str | None]:
    """What a person may read into the same conversations judged before and now (pairs of them, fixed and broken as
    in mcnemar), and which way the errors went: few pairs say nothing more; otherwise the difference is beyond chance or
    within it (McNemar, LEVEL), or there is none."""
    if not pairs:
        return None, None
    direction = 'same' if fixed == broken else 'fewer' if fixed > broken else 'more'
    if pairs < FEW:
        return 'few', direction
    if direction == 'same':
        return 'same', direction
    return ('beyond-chance' if mcnemar(fixed, broken) < LEVEL else 'within-chance'), direction
