"""Verbatim quotes, the Lab's rule of evidence.

A rule stands on a quote from its source (found); a verdict stands on a quote from the agent's replies (cited)."""

import re

_MARKUP = re.compile(r'[\*_`#>«»"„“”\[\]]+')
# Letters and digits in every part of a verdict's quote stitched with «…»: about two words of the agent's own.
STITCHED_PART = 15


def normalized(text: str) -> str:
    text = _MARKUP.sub(' ', (text or '').replace('ё', 'е').replace('Ё', 'Е'))
    return re.sub(r'\s+', ' ', text).strip().lower()


def _parts(quote: str) -> list[str]:
    return [part for part in (normalized(p) for p in re.split(r'\.{3}|…', quote or '')) if part]


def _letters(text: str) -> int:
    return sum(ch.isalnum() for ch in text)


def found(quote: str, text: str) -> bool:
    """Every meaningful fragment of the quote (split at an ellipsis) appears in the text, markup and case aside."""
    haystack = normalized(text)
    parts = _parts(quote)
    if not parts or not any(_letters(part) >= 8 for part in parts):
        return False
    cursor = 0
    for part in parts:
        start = haystack.find(part, cursor)
        if start < 0:
            return False
        cursor = start + len(part)
    return True


def cited(quote: str, text: str) -> bool:
    """A verdict's quote is found in the agent's words, and a quote stitched with «…» has no short part: «Вернуть
    деньги на карту … можно» would leave out the «нельзя» between its parts. The agent's own «…» is quoted whole."""
    whole = normalized(quote)
    if _letters(whole) >= 8 and whole in normalized(text):
        return True
    parts = _parts(quote)
    return (len(parts) < 2 or all(_letters(part) >= STITCHED_PART for part in parts)) and found(quote, text)
