"""A suggestion at a person's request, grounded in the evidence of the current result, never changing the rules, the
quotes or the verdicts (roles.advice): a rewrite of the agent's words where tone of voice found an error, or a
clarification of a criterion from every case where people corrected the model by it."""

from itertools import zip_longest

from .. import models, storage
from ..domain import checks, export, quotes, verdicts
from ..domain.tone import KIND, for_judging, judged
from ..roles import advice
from . import tone
from .checks import current

# The corrected cases a clarification is proposed from, at most: enough to show what the model reads otherwise than
# people do, few enough for one call.
CASES = 10
NONE_CORRECTED = 'По этому критерию вы ещё не поправляли модель: ответьте «Нет» там, где она ошиблась.'


def _criterion(analysis: dict, finished_at: str, rule_id: str) -> dict:
    """The criterion rule_id of the current result the person saw (finished_at), while the criteria in force read it as
    that result did; a ValueError when the result or the rules changed since, or this criterion did. Another criterion
    clarified since leaves this one as the check read it."""
    draft = storage.documents.load(tone.DRAFT) or {}
    if analysis.get('purpose') != KIND or analysis.get('finishedAt') != finished_at:
        raise ValueError('Итог проверки изменился. Обновите страницу.')
    # Also verifies the active policy still matches the draft.
    [now] = tone.selection([rule_id], draft.get('revision'))
    rule = next(
        (rule for topic in analysis.get('topics', []) for rule in topic['rules'] if rule['id'] == rule_id), None
    )
    if rule is None:
        raise ValueError('В текущем итоге нет этого критерия.')
    if for_judging(now) != for_judging(rule):
        raise ValueError('Критерий изменился после этой проверки: следующая проверка прочитает его по-новому.')
    return rule


def _as_seen(messages: list[dict]) -> list[dict]:
    """The model reads the replies as the judge read them: with the buttons the customer saw instead of the export's
    control code."""
    return [
        {**message, 'content': export.as_seen(message['content'])} if message['role'] == 'assistant' else message
        for message in messages
    ]


def context(finished_at: str, dialogue_id: str, rule_id: str) -> dict:
    """The evidence of an error of the current result the person saw (finished_at); a ValueError when the result, the
    criteria or the rules changed since, or the error has no quote of the agent's words."""
    analysis = storage.documents.load(tone.RESULT) or {}
    rule = _criterion(analysis, finished_at, rule_id)
    result = next((item for item in analysis['results'] if str(item['dialogueId']) == dialogue_id), None)
    verdict = next((row for row in (result or {}).get('rules', []) if row['ruleId'] == rule_id), None)
    dialogue = storage.dialogues.get(dialogue_id)
    if verdict is None or dialogue is None:
        raise ValueError('В текущем итоге нет этого разговора или критерия.')
    if verdict['status'] != 'FAIL':
        raise ValueError('Предложение можно получить только для найденной ошибки.')
    # The quote is checked as the judge checked it.
    if not quotes.cited(verdict.get('agentQuote', ''), verdicts.log_words(export.conversation(dialogue))):
        raise ValueError('Для этой ошибки нет подтверждённой цитаты ответа агента.')
    return {
        'criterion': rule,
        'policy': tone.current_policy()['content'],
        'verdict': verdict,
        'targetExcerpt': verdict['agentQuote'],
        'conversation': _as_seen(dialogue['messages']),
    }


def corrected(finished_at: str, rule_id: str) -> dict:
    """The evidence of a clarification of criterion rule_id: the criterion, the rules, and the cases of the current
    result where people corrected the model by it — an error it found where people say there is none, an error people
    found where it saw none — at most CASES, the two kinds in turn, each in the result's order. Every case comes with
    the conversation as the check showed it to the judge (its saved check). A ValueError when the result or the
    criteria changed since the person saw them (finished_at), or nobody corrected the model by the criterion."""
    analysis = current(checks.TONE) or {}
    rule = _criterion(analysis, finished_at, rule_id)
    kinds: dict[str, list[tuple[str, dict]]] = {'FAIL': [], 'PASS': []}
    for result in analysis.get('results') or []:
        for row in result.get('rules') or []:
            if row.get('ruleId') == rule_id and row.get('review') == 'disagree' and row.get('status') in kinds:
                kinds[row['status']].append((str(result['dialogueId']), row))
    if not kinds['FAIL'] and not kinds['PASS']:
        raise ValueError(NONE_CORRECTED)
    talks, _, _ = judged(storage.history.get(checks.TONE, analysis.get('checkId') or '') or {})
    cases = [
        {
            'judged': row['status'],
            'reason': row.get('reason', ''),
            'agentQuote': row.get('agentQuote', ''),
            'conversation': _as_seen(talks[dialogue_id]['messages']),
        }
        for pair in zip_longest(kinds['FAIL'], kinds['PASS'])
        for dialogue_id, row in filter(None, pair)
        if dialogue_id in talks
    ][:CASES]
    if not cases:
        raise ValueError('Разговоров, где вы поправили модель, в этой проверке не сохранилось.')
    return {'criterion': rule, 'policy': tone.current_policy()['content'], 'cases': cases}


async def suggest(finished_at: str, dialogue_id: str, rule_id: str) -> dict:
    """A rewrite of the agent's words where the error was found, still for the result the person saw."""
    evidence = context(finished_at, dialogue_id, rule_id)
    with models.about('advice:tone'):
        answer = await advice.rewrite(evidence)
    tone.ensure_active()
    # Ownership blocks input changes; repeat freshness validation before returning a model result.
    context(finished_at, dialogue_id, rule_id)
    return answer.value


async def clarify(finished_at: str, rule_id: str, note: str) -> dict:
    """One clarification of the criterion from the cases people corrected the model in by it (corrected), with the
    person's note on what it gets wrong when there is one; still for the result the person saw."""
    evidence = corrected(finished_at, rule_id)
    with models.about('advice:tone'):
        answer = await advice.clarify(evidence, note.strip())
    tone.ensure_active()
    _criterion(storage.documents.load(tone.RESULT) or {}, finished_at, rule_id)
    return answer.value
