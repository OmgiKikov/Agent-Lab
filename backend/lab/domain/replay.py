"""The live agent on the same customers: the conversations of a check's result played again with the agent under test,
and how they compare with the recordings, pair by pair. Pure: no model, no storage.

A played conversation starts with the customer's real first message, word for word; then the synthetic customer wants
what the customer of the recording wanted (situation), and the agent answers as many times as it did in the recording.
It is judged by the same judge and criteria as the recordings, so a pair differs in the agent's replies only.
"""

from . import sampling
from .comparison import evaluation_fingerprint
from .problems import rule_key
from .statistics import paired

MAX_REPLIES = 3  # the agent's replies in a played conversation, as in a run of scenarios
LIMIT = 300  # conversations of a result played at most, as a check takes at most
DECIDED = ('PASS', 'FAIL')
# What a pair says, by the verdicts before (in the recording) and now.
CHANGE = {
    ('FAIL', 'PASS'): 'fixed',
    ('PASS', 'FAIL'): 'broken',
    ('FAIL', 'FAIL'): 'failing',
    ('PASS', 'PASS'): 'passing',
}


def _said(text: object, limit: int = 500) -> str:
    return ' '.join(str(text or '').split())[:limit]


def opening(dialogue: dict) -> str:
    """The customer's real first message, word for word: the agent gets what it got then."""
    return next((m['content'] for m in dialogue.get('messages') or [] if m.get('role') == 'user'), '')


def replies(dialogue: dict) -> int:
    """How many times the agent answers: as in the recording, at least once, at most MAX_REPLIES."""
    count = sum(1 for m in dialogue.get('messages') or [] if m.get('role') == 'assistant')
    return max(1, min(MAX_REPLIES, count))


def situation(dialogue: dict) -> str:
    """What the synthetic customer plays: the customer's own words in the recording, to want the same."""
    lines = [_said(m.get('content')) for m in dialogue.get('messages') or [] if m.get('role') == 'user']
    said = '\n'.join(f'{n}. «{line}»' for n, line in enumerate(lines[:10], 1) if line)
    return (
        'Ты — клиент из настоящего разговора с чат-ботом. Вот что ты писал тогда, по порядку:\n'
        f'{said}\n'
        'Добивайся того же, что и тогда. Первую реплику ты уже написал. Отвечай на вопросы агента по смыслу этих '
        'реплик; если агент спросит то, чего в них нет, скажи, что не знаешь.\n'
        'Цифры и имена в записи скрыты знаками # и *: если агент попросит номер или имя, назови правдоподобные.'
    )


def as_dialogue(item: dict) -> dict:
    """A played conversation as a recorded one, for the judge of the recordings: the customer's lines and the agent's
    replies with the buttons it sent, as an export writes them."""
    messages = []
    for turn in item.get('conversation') or []:
        if turn['role'] == 'customer':
            messages.append({'role': 'user', 'content': turn['text']})
            continue
        buttons = turn.get('options') or []
        content = turn['text'] + (f'\n[Кнопки: {" | ".join(buttons)}]' if buttons else '')
        messages.append({'role': 'assistant', 'content': content})
    return {'id': item['dialogueId'], 'messages': messages}


def chosen(result: dict, count: int) -> list[str]:
    """The customers to meet again: of the conversations the result judged (a decided verdict), `count` of them, the
    same ones for the same result and count."""
    judged = [str(r['dialogueId']) for r in result.get('results') or [] if r.get('status') in DECIDED]
    return sampling.sampled(judged, min(count, LIMIT))


def change(item: dict) -> str:
    """What a played conversation says beside its recording: fixed, broken, failing, passing; unmeasured when either
    has no decided verdict; running while it plays."""
    if item.get('status') == 'RUNNING':
        return 'running'
    return CHANGE.get((item['before']['status'], item.get('status')), 'unmeasured')


def _counts(verdicts: list[list[dict]]) -> dict:
    """Of the conversations whose rows on a criterion were decided: those with an error by it."""
    decided = [any(row['status'] == 'FAIL' for row in rows) for rows in verdicts if rows]
    return {'failed': sum(decided), 'measured': len(decided)}


def _criteria(topics: list[dict], pairs: list[dict]) -> list[dict]:
    """Each criterion of the check by its key (problems.rule_key, as the problems name it): the conversations of the
    pairs with an error by it, before and now, among those where it was decided."""
    found: dict[str, dict] = {}
    for topic in topics:
        for rule in topic['rules']:
            key = rule_key(rule.get('quote') or rule['text'])
            entry = found.setdefault(key, {'id': key, 'name': rule.get('name') or rule['text'], 'ruleIds': set()})
            entry['ruleIds'].add(rule['id'])
    criteria = []
    for entry in found.values():
        ids = entry.pop('ruleIds')

        def decided(rows: list[dict], ids: set[str] = ids) -> list[dict]:
            return [row for row in rows if row.get('ruleId') in ids and row.get('status') in DECIDED]

        before = _counts([decided(item['before'].get('rules') or []) for item in pairs])
        now = _counts([decided(item.get('rules') or []) for item in pairs])
        if before['measured'] or now['measured']:
            criteria.append(entry | {'before': before, 'now': now})
    return criteria


def summarize(record: dict) -> dict:
    """The pairs of a check of the live agent: what changed, the conversations with an error before and now among them,
    what may be read into the difference (statistics.paired), and each criterion before and now. comparable: the
    recordings and the played conversations were judged by the same models and instructions; otherwise the numbers
    stand and nothing is concluded from them."""
    items = record.get('items') or []
    changes = [change(item) for item in items]
    pairs = [item for item, said in zip(items, changes, strict=True) if said in CHANGE.values()]
    fixed, broken, failing = changes.count('fixed'), changes.count('broken'), changes.count('failing')
    then = evaluation_fingerprint({'results': [item['before'] for item in pairs], 'model': None})
    comparable = not pairs or then == evaluation_fingerprint({'results': pairs, 'model': None})
    verdict, direction = paired(fixed, broken, len(pairs))
    return {
        'pairs': len(pairs),
        'fixed': fixed,
        'broken': broken,
        'failing': failing,
        'passing': changes.count('passing'),
        'unmeasured': changes.count('unmeasured'),
        'running': changes.count('running'),
        'before': {'failed': fixed + failing, 'measured': len(pairs)},
        'now': {'failed': broken + failing, 'measured': len(pairs)},
        'comparable': comparable,
        'verdict': verdict if comparable else None,
        'direction': direction,
        'criteria': _criteria(record.get('topics') or [], pairs),
    }
