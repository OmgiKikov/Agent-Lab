"""Verbatim quotes, the Lab's rule of evidence.

A rule stands on a quote from its source (found); a verdict stands on a quote from the agent's replies (cited). A quote
is the words as they are written, typography aside (another dash, ellipsis or apostrophe, a soft hyphen, a letter
encoded otherwise). It starts where a word starts, and never right after a negation it leaves out: «можно оплатить
картой» is not in «невозможно оплатить картой», nor «обещай сроки» in «Не обещай сроки»."""

import re
import unicodedata

_MARKUP = re.compile(r'[\*_`#>«»"„“”\[\]]+')
# What a faithful copy of a text may write otherwise: invisible characters, dashes, apostrophes.
_INVISIBLE = re.compile('[\u00ad\u200b\u200c\u200d\u2060\ufeff]')  # soft hyphen, zero-width spaces
_DASHES = re.compile('[\u2010-\u2015\u2212]')  # hyphens, dashes, minus
_APOSTROPHES = re.compile('[\u2018\u2019\u02bc\u2032]')  # typographic apostrophes, prime
# A word that, left out right before a quote, turns the quoted words into their opposite.
NEGATIONS = frozenset({'не', 'ни', 'нельзя'})
# Letters and digits in every part of a verdict's quote stitched with «…»: about two words of the agent's own.
STITCHED_PART = 15
# The export's masks as letters, so a masked value is a word of the message: # hides digits, * hides text.
_MASKS = str.maketrans({'#': 'ǂ', '*': 'ǁ'})
# Spacing around punctuation: a copy may write «ИНН: 7701» for «ИНН:7701», or break a line there.
_PUNCTUATION_SPACE = re.compile(r'\s*([^\w\s])\s*')


def normalized(text: str) -> str:
    """Markup, case and «ё» aside. The key of a quote (problems.rule_key) is made of it: it stays as it is, so the
    decisions people stored by those keys keep finding their criteria."""
    text = _MARKUP.sub(' ', (text or '').replace('ё', 'е').replace('Ё', 'Е'))
    return re.sub(r'\s+', ' ', text).strip().lower()


def _comparable(text: str) -> str:
    """normalized, typography aside: the same words with another dash, ellipsis («…» is «...») or apostrophe, with a
    soft hyphen, or with letters encoded otherwise (NFKC) compare equal."""
    text = unicodedata.normalize('NFKC', _INVISIBLE.sub('', text or ''))
    return normalized(_APOSTROPHES.sub("'", _DASHES.sub('-', text)))


def _parts(quote: str) -> list[str]:
    return [part.strip() for part in re.split(r'\.{3}', _comparable(quote)) if part.strip()]


def _letters(text: str) -> int:
    return sum(ch.isalnum() for ch in text)


def _negated(haystack: str, at: int) -> bool:
    """Whether a negation stands right before `at`, a space between: the word is read back from there."""
    end = at
    while end > 0 and haystack[end - 1].isspace():
        end -= 1
    start = end
    while start > 0 and haystack[start - 1].isalnum():
        start -= 1
    return end < at and haystack[start:end] in NEGATIONS


def _at(part: str, haystack: str, start: int) -> int:
    """Where the part stands in the haystack from `start` on as a quote may stand, -1 when nowhere: at the start of a
    word, and not right after a negation the quote leaves out."""
    at = haystack.find(part, start)
    while at >= 0:
        inside_word = at > 0 and haystack[at - 1].isalnum() and part[:1].isalnum()
        if not inside_word and not _negated(haystack, at):
            return at
        at = haystack.find(part, at + 1)
    return -1


def found(quote: str, text: str) -> bool:
    """Every meaningful fragment of the quote (split at an ellipsis) appears in the text, in order, markup, case and
    typography aside."""
    haystack = _comparable(text)
    parts = _parts(quote)
    if not parts or not any(_letters(part) >= 8 for part in parts):
        return False
    cursor = 0
    for part in parts:
        start = _at(part, haystack, cursor)
        if start < 0:
            return False
        cursor = start + len(part)
    return True


def spoken(quote: str, text: str, *, masks: bool = False) -> bool:
    """A quote of one chat message, as a card cites it: the whole quote stands in the message where a word starts and
    not right after a negation it leaves out, markup, case, typography and spacing around punctuation aside. A short
    reply («да», «нет») is a quote. masks: the export's masks (# for digits, * for hidden text) are words of the
    message, not markup: a customer's «########» is their reply, and a quote that shows a mask stands only where the
    message has one."""
    if masks:
        quote, text = quote.translate(_MASKS), text.translate(_MASKS)
    whole = _PUNCTUATION_SPACE.sub(r'\1', _comparable(quote))
    return _letters(whole) >= 2 and _at(whole, _PUNCTUATION_SPACE.sub(r'\1', _comparable(text)), 0) >= 0


def cited(quote: str, text: str) -> bool:
    """A verdict's quote is found in the agent's words, and a quote stitched with «…» has no short part: «Вернуть
    деньги на карту … можно» would leave out the «нельзя» between its parts. The agent's own «…» is quoted whole."""
    whole = _comparable(quote)
    if _letters(whole) >= 8 and _at(whole, _comparable(text), 0) >= 0:
        return True
    parts = _parts(quote)
    return (len(parts) < 2 or all(_letters(part) >= STITCHED_PART for part in parts)) and found(quote, text)


def same_finding(status: str | None, quote: str | None, other: str | None) -> bool:
    """Whether a person's answer on a verdict still belongs to a new verdict of the same status. An error is the words
    it points at: the answer «это не ошибка» on «Здравствуйте!!!» says nothing of «Вы сами виноваты», so it moves only
    with the same quote. «Без ошибки» is about the conversation by the criterion, whatever words show it."""
    return status != 'FAIL' or _comparable(quote or '') == _comparable(other or '')
