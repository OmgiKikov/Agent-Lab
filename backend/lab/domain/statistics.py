"""Whether the difference between two shares of errors says more than chance (docs/superpowers/specs/
2026-10-04-was-is-design.md, section 3): a fact about the shares, not a judgement of the agent."""

from math import comb

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
