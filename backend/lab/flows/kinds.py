"""The kinds of the errors each criterion of a check of tone of voice found: the judge names every error in its own
words, one mistake under many names; the model groups the names by the mistake (roles.kinds), so «Чаще всего» counts a
mistake whatever its wording and a problem's page lists its kinds. A check groups them before it is published and
keeps them in its result (`kinds`, by criterion); a criterion left without them — in a result checked before, or one
the model could not group then — is grouped on request («Сгруппировать ошибки»). Grouping never fails a check: a
criterion the model could not group keeps its names as they are."""

import logging
from collections import Counter

from .. import models, storage
from ..domain import checks
from ..roles import kinds as grouping
from ..roles.base import UNUSABLE
from . import Progress

log = logging.getLogger(__name__)

GROUPING = 'Группируем ошибки по видам'
# The names of one criterion's errors the model groups, at most: the most frequent; the rest stay other errors.
NAMES_AT_MOST = 200


def names(result: dict) -> dict[str, Counter]:
    """The names the judge gave each criterion's errors in the result, with how many errors bear each."""
    found: dict[str, Counter] = {}
    for item in result.get('results') or []:
        for row in item.get('rules') or []:
            title = (row.get('title') or '').strip()
            if row.get('status') == 'FAIL' and title:
                found.setdefault(row['ruleId'], Counter())[title] += 1
    return found


def ungrouped(result: dict) -> dict[str, Counter]:
    """The criteria of the result whose errors bear two names or more and have no kinds yet, with their names."""
    criteria = {rule['id'] for topic in result.get('topics') or [] for rule in topic['rules']}
    kept = result.get('kinds') or {}
    return {
        rule_id: counter
        for rule_id, counter in names(result).items()
        if rule_id in criteria and rule_id not in kept and len(counter) > 1
    }


async def grouped(result: dict, progress: Progress, *, strict: bool = False) -> dict[str, list[dict]]:
    """The kinds of each criterion of the result still to group (ungrouped), by criterion id. A criterion the model
    could not group is left out. A model that cannot be asked at all ends the grouping with what it has, or, `strict`
    (a person asked for the grouping), with its error."""
    criteria = {rule['id']: rule for topic in result.get('topics') or [] for rule in topic['rules']}
    todo = list(ungrouped(result).items())
    kinds: dict[str, list[dict]] = {}
    for done, (rule_id, counter) in enumerate(todo):
        progress(done=done, total=len(todo), message=GROUPING)
        try:
            answer = await grouping.grouped(criteria[rule_id], counter.most_common(NAMES_AT_MOST))
        except models.ModelError as error:
            if str(error) == UNUSABLE:
                continue
            if strict:
                raise
            # Out of its limit or out of reach: every criterion after this one would fail the same way.
            log.warning('Ошибки не сгруппированы: %s', error)
            break
        kinds[rule_id] = answer.value
    return kinds


async def regroup(progress: Progress) -> dict:
    """«Сгруппировать ошибки»: the kinds of the criteria of the current result of tone of voice that have none yet.
    Kept in that result while it is the one in force; the record of the check in the history stays as it was saved."""
    name = checks.result(checks.TONE)
    result = storage.documents.load(name) or {}
    if not result.get('results'):
        raise ValueError('Сначала проверьте разговоры.')
    with models.about(f'check:{result.get("checkId") or "kinds"}'):
        found = await grouped(result, progress, strict=True)
    with storage.transaction():
        now = storage.documents.load(name) or {}
        if now.get('finishedAt') != result.get('finishedAt'):
            raise ValueError('Итог проверки изменился, пока группировались ошибки. Сгруппируйте их заново.')
        storage.documents.save(name, now | {'kinds': (now.get('kinds') or {}) | found})
    return {'criteria': len(found)}
