"""Which conversations of an export a check takes: the same ones for the same export, in whatever order its rows come,
so the same set exported again in another order is checked again as the same conversations, not as «другие разговоры».
"""

import random

SEED = 20260928  # the same sample of conversations in every check


def sampled(ids: list[str], count: int) -> list[str]:
    """`count` of the conversations by their ids, chosen by SEED from the ids in order."""
    chosen = sorted(ids)
    random.Random(SEED).shuffle(chosen)
    return chosen[:count]
