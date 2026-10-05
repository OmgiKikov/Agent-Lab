"""A person's answers on the judge's verdicts, kept apart from the verdicts (storage.reviews): what a case is, how the
answers are laid on a result or a run for the screens, which ones a changed verdict takes back, and how they are
counted. An answer belongs to the verdict it was given on: the same status and, for an error, the same words of the
agent (quotes.same_finding). Pure functions.

A case is a criterion of a conversation of a record: of a check's result (LOG: the saved check, the conversation's id)
or of a run (SIM: the run, the conversation's index). An answer on a played conversation as a whole, from older
screens, is on the criterion WHOLE.
"""

from . import quotes

LOG, SIM = 'log', 'sim'
DECISIONS = ('agree', 'disagree')
WHOLE = ''


def record_of(check: str, result: dict) -> str:
    """What the answers on a check's result are kept under: its saved check. A result from before the history of
    checks has none; its answers are kept under the check and the time it finished."""
    return result.get('checkId') or f'{check}@{result.get("finishedAt")}'


def found(conversation: str, rule_id: str, decision: str | None, verdict: dict, version: str | None = None) -> dict:
    """An answer on a case with the verdict it was given on: the verdict's status, the agent's words it quoted and the
    version of the judge's instructions that gave it."""
    return {
        'conversation': conversation,
        'rule': rule_id,
        'decision': decision,
        'status': verdict.get('status'),
        'quote': verdict.get('agentQuote'),
        'version': version,
    }


def taken_from_result(result: dict) -> tuple[dict, list[dict]]:
    """The result as it is kept, its verdicts without answers, and the answers it carried (found)."""
    taken: list[dict] = []
    judged = []
    for item in result.get('results') or []:
        if 'rules' not in item:
            judged.append(item)
            continue
        rows = []
        for row in item['rules'] or []:
            if 'review' in row:
                if row['review'] in DECISIONS:
                    taken.append(
                        found(str(item['dialogueId']), row['ruleId'], row['review'], row, item.get('judgeVersion'))
                    )
                row = {key: value for key, value in row.items() if key != 'review'}
            rows.append(row)
        judged.append({**item, 'rules': rows})
    return ({**result, 'results': judged} if 'results' in result else result), taken


def taken_from_run(record: dict) -> tuple[dict, list[dict]]:
    """The run as it is kept, its verdicts without answers, and the answers it carried (found): on a criterion, or on
    the whole conversation (WHOLE)."""
    taken: list[dict] = []
    items = []
    for index, item in enumerate(record.get('items') or []):
        conversation, version = str(index), item.get('judgeVersion')
        rows = []
        for row in item.get('rules') or []:
            if 'review' in row:
                if row['review'] in DECISIONS and row.get('ruleId'):
                    taken.append(found(conversation, row['ruleId'], row['review'], row, version))
                row = {key: value for key, value in row.items() if key != 'review'}
            rows.append(row)
        kept = {key: value for key, value in item.items() if key != 'review'}
        if item.get('review') in DECISIONS:
            taken.append(found(conversation, WHOLE, item['review'], {'status': item.get('status')}, version))
        items.append({**kept, 'rules': rows} if 'rules' in item else kept)
    return ({**record, 'items': items} if 'items' in record else record), taken


def bare(item: dict) -> dict:
    """A played conversation, or a patch of one, without answers: verdicts only. A copy that still carries an answer
    (a producer's copy of an older record) never brings it back."""
    kept = {key: value for key, value in item.items() if key != 'review'}
    if isinstance(kept.get('rules'), list):
        kept['rules'] = [{key: value for key, value in row.items() if key != 'review'} for row in kept['rules']]
    return kept


def on_result(result: dict, visible: dict[tuple[str, str], dict]) -> dict:
    """The result with the answers people gave on its verdicts: `review` on a criterion's row. A saved check's verdicts
    never change, so every answer kept under it is on the verdict it stands beside."""
    if not visible:
        return result
    judged = []
    for item in result.get('results') or []:
        conversation = str(item.get('dialogueId'))
        rows = [
            {**row, 'review': visible[(conversation, row.get('ruleId'))]['decision']}
            if (conversation, row.get('ruleId')) in visible
            else row
            for row in item.get('rules') or []
        ]
        judged.append({**item, 'rules': rows} if 'rules' in item else item)
    return {**result, 'results': judged}


def on_run(record: dict, visible: dict[tuple[str, str], dict]) -> dict:
    """The run with the answers on its conversations: on a criterion's verdict, or on the whole conversation; its
    metric counts them (human). Answers on a verdict a later judgement changed were taken back when it changed
    (withdrawn), so every visible one stands beside the verdict it was given on."""
    items = []
    for index, item in enumerate(record.get('items') or []):
        conversation = str(index)
        rows = [
            {**row, 'review': visible[(conversation, row.get('ruleId'))]['decision']}
            if (conversation, row.get('ruleId')) in visible
            else row
            for row in item.get('rules') or []
        ]
        laid = {**item, 'rules': rows} if 'rules' in item else dict(item)
        whole = visible.get((conversation, WHOLE))
        if whole is not None:
            laid['review'] = whole['decision']
        items.append(laid)
    return {**counted(record, visible), 'items': items} if 'items' in record else counted(record, visible)


def counted(record: dict, visible: dict[tuple[str, str], dict]) -> dict:
    """A run, or its summary, with the decisions people gave on its verdicts in its metric (human)."""
    metric = record.get('metric')
    if not isinstance(metric, dict):
        return record
    found = human(visible)
    kept = {key: value for key, value in metric.items() if key != 'human'}
    return {**record, 'metric': kept | ({'human': found} if found else {})}


def human(visible: dict[tuple[str, str], dict]) -> dict | None:
    """A person's decisions on a run's verdicts: on each conversation its answers on criteria, else the answer on the
    whole conversation (older screens). None without a decision."""
    by_conversation: dict[str, tuple[list[str], str | None]] = {}
    for (conversation, rule_id), answer in visible.items():
        rules, whole = by_conversation.get(conversation, ([], None))
        if answer['decision'] in DECISIONS:
            if rule_id == WHOLE:
                whole = answer['decision']
            else:
                rules = [*rules, answer['decision']]
        by_conversation[conversation] = (rules, whole)
    decisions = [d for rules, whole in by_conversation.values() for d in (rules or ([whole] if whole else []))]
    return {'reviewed': len(decisions), 'agree': decisions.count('agree')} if decisions else None


def withdrawn(before: dict, after: dict, answers: dict[str, dict]) -> list[str]:
    """The criteria of a played conversation (WHOLE: the conversation as a whole) whose visible answers no longer belong
    to its verdicts after a change (before → after): a criterion judged otherwise, or an error with other words of the
    agent; the conversation as a whole once its status or any verdict changed. answers: the visible answers on it by
    criterion."""
    rows = {row.get('ruleId'): row for row in after.get('rules') or []}
    gone = []
    for rule_id, answer in answers.items():
        if answer['decision'] not in DECISIONS:
            continue
        if rule_id == WHOLE:
            if after.get('status') != before.get('status') or after.get('rules') != before.get('rules'):
                gone.append(rule_id)
            continue
        row = rows.get(rule_id)
        if (
            row is None
            or row.get('status') != answer['status']
            or not quotes.same_finding(answer['status'], answer['quote'], row.get('agentQuote'))
        ):
            gone.append(rule_id)
    return gone
