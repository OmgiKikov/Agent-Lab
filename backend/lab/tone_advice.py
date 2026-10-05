"""Requested, evidence-grounded suggestions; never changes the policy or a verdict."""

from . import discover, logs, models, quotes, store, tone
from .domain import export, verdicts
from .roles import advice


def context(finished_at: str, dialogue_id: str, rule_id: str) -> dict:
    analysis = store.load(tone.RESULT) or {}
    draft = store.load(tone.DRAFT) or {}
    if analysis.get('purpose') != tone.KIND or analysis.get('finishedAt') != finished_at:
        raise ValueError('Итог проверки изменился. Обновите страницу.')
    if analysis.get('criteriaRevision') != draft.get('revision'):
        raise ValueError('Критерии изменились. Сначала проверьте разговоры по новым критериям.')
    # Also verifies the active policy still matches the draft.
    tone.selection([rule_id], draft.get('revision'))
    rule = next(
        (rule for topic in analysis.get('topics', []) for rule in topic['rules'] if rule['id'] == rule_id), None
    )
    result = next((item for item in analysis['results'] if str(item['dialogueId']) == dialogue_id), None)
    verdict = next((row for row in (result or {}).get('rules', []) if row['ruleId'] == rule_id), None)
    dialogue = logs.read(dialogue_id)
    if rule is None or verdict is None or dialogue is None:
        raise ValueError('В текущем итоге нет этого разговора или критерия.')
    if verdict['status'] != 'FAIL':
        raise ValueError('Предложение можно получить только для найденной ошибки.')
    # The quote is checked as the judge checked it, and the model reads the replies as the judge read them: with
    # the buttons the customer saw instead of the export's control code.
    if not quotes.cited(verdict.get('agentQuote', ''), verdicts.log_words(discover.conversation(dialogue))):
        raise ValueError('Для этой ошибки нет подтверждённой цитаты ответа агента.')
    return {
        'criterion': rule,
        'policy': tone.current_policy()['content'],
        'verdict': verdict,
        'targetExcerpt': verdict['agentQuote'],
        'conversation': [
            {**message, 'content': export.as_seen(message['content'])} if message['role'] == 'assistant' else message
            for message in dialogue['messages']
        ],
    }


async def suggest(finished_at: str, dialogue_id: str, rule_id: str, mode: str, note: str) -> dict:
    evidence = context(finished_at, dialogue_id, rule_id)
    note = note.strip()
    if mode == 'clarify' and not 10 <= len(note) <= 2000:
        raise ValueError('Опишите допустимую ситуацию: от 10 до 2000 символов.')
    with models.about('advice:tone'):
        answer = await advice.suggest(evidence, mode, note)
    tone.ensure_active()
    # Ownership blocks input changes; repeat freshness validation before returning a model result.
    context(finished_at, dialogue_id, rule_id)
    return answer.value
