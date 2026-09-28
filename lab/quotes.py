"""Verbatim quotes, the Lab's rule of evidence.

A rule stands on a quote from its source; a verdict stands on a quote from the agent's replies."""

import re

_MARKUP = re.compile(r'[\*_`#>«»"„“”\[\]]+')


def normalized(text: str) -> str:
    text = _MARKUP.sub(' ', (text or '').replace('ё', 'е').replace('Ё', 'Е'))
    return re.sub(r'\s+', ' ', text).strip().lower()


def found(quote: str, text: str) -> bool:
    """Every meaningful fragment of the quote (split at an ellipsis) appears in the text, markup and case aside."""
    haystack = normalized(text)
    parts = [normalized(p) for p in re.split(r'\.{3}|…', quote or '')]
    parts = [p for p in parts if p]
    return bool(parts) and sum(len(p) for p in parts) >= 8 and all(p in haystack for p in parts)
