"""Help a person with an error tone of voice found: a rewrite of the agent's words in the tone the rules ask for, or a
clarification of the criterion for a situation the person says is allowed. A suggestion, never a fix: the rules, the
quote and the verdict stay as they are."""

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


def protected(text: str) -> Counter:
    """The amounts, dates and electronic contacts written in a text: a rewrite keeps every one of them."""
    return Counter(re.findall(r'https?://\S+|[\w.+-]+@[\w.-]+\.\w+|\d+(?:[.,:/-]\d+)*%?', text))


async def suggest(evidence: dict, mode: str, note: str) -> Answer[dict]:
    """{text, explanation}: a rewrite of evidence['targetExcerpt'] (mode rewrite), or a clarification of the criterion
    by the person's note (mode clarify)."""

    def usable(reply: Advice) -> dict:
        lowest, highest = LIMITS[mode]
        if not lowest <= len(reply.text.strip()) <= highest:
            raise ValueError('Invalid suggestion text')
        if not 1 <= len(reply.explanation.strip()) <= 2000:
            raise ValueError('Invalid suggestion explanation')
        if mode == 'rewrite' and protected(reply.text) != protected(evidence['targetExcerpt']):
            raise ValueError('Предложение изменяет числа, даты или контакты исходного ответа.')
        return {'text': reply.text.strip(), 'explanation': reply.explanation.strip()}

    return await ask(ADVICE, {**evidence, 'mode': mode, 'humanNote': note}, accept=usable)
