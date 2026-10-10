"""Help a person with what tone of voice found: a rewrite of the agent's words in the tone the rules ask for, or a
clarification of a criterion the model reads otherwise than people do, from the cases they corrected it in. A
suggestion, never a fix: the rules, the quotes and the verdicts stay as they are."""

import re
from collections import Counter

from pydantic import BaseModel, ConfigDict

from .base import Answer, Role, ask, instructions

LIMITS = {'rewrite': (1, 12000), 'clarify': (10, 2000)}  # characters of the suggestion's text


class Advice(BaseModel):
    model_config = ConfigDict(strict=True)

    text: str
    explanation: str


ADVICE = Role('tone.advice', instructions('tone.advice'), Advice)
CLARIFY = Role('tone.clarify', instructions('tone.clarify'), Advice)


def protected(text: str) -> Counter:
    """The amounts, dates and electronic contacts written in a text: a rewrite keeps every one of them."""
    return Counter(re.findall(r'https?://\S+|[\w.+-]+@[\w.-]+\.\w+|\d+(?:[.,:/-]\d+)*%?', text))


def _usable(mode: str, reply: Advice) -> dict:
    """The suggestion trimmed, when its text and explanation are of the lengths the screens take."""
    lowest, highest = LIMITS[mode]
    if not lowest <= len(reply.text.strip()) <= highest:
        raise ValueError('Invalid suggestion text')
    if not 1 <= len(reply.explanation.strip()) <= 2000:
        raise ValueError('Invalid suggestion explanation')
    return {'text': reply.text.strip(), 'explanation': reply.explanation.strip()}


async def rewrite(evidence: dict) -> Answer[dict]:
    """{text, explanation}: a rewrite of evidence['targetExcerpt'] that keeps its amounts, dates and contacts."""

    def usable(reply: Advice) -> dict:
        if protected(reply.text) != protected(evidence['targetExcerpt']):
            raise ValueError('Предложение изменяет числа, даты или контакты исходного ответа.')
        return _usable('rewrite', reply)

    return await ask(ADVICE, evidence, accept=usable)


async def clarify(evidence: dict, note: str) -> Answer[dict]:
    """{text, explanation}: one clarification of evidence['criterion'] by which the judge would decide
    evidence['cases'] as people did, with the person's note on what it gets wrong (empty without one)."""
    return await ask(CLARIFY, {**evidence, 'humanNote': note}, accept=lambda reply: _usable('clarify', reply))
