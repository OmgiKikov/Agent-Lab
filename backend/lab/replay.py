"""Replay of exported conversations through the local agent: a step for every customer message, the history taken from
the logs, the agent's trace on every step, a verdict on the new reply (spec 2026-10-05-voice360-replay-design.md)."""

from . import discover, logs, rag, store, tone

RESULT = 'replay.json'
FAMILIES = ('tone', 'code', 'rag')


def steps(dialogue: dict) -> list[dict]:
    """A step for every customer message: the log before it, the message, and production's reply to it, if any."""
    said = [
        {'role': 'customer' if m['role'] == 'user' else 'agent', 'text': m['content']} for m in dialogue['messages']
    ]
    out = []
    for index, message in enumerate(said):
        if message['role'] != 'customer':
            continue
        following = said[index + 1] if index + 1 < len(said) else None
        reply = following['text'] if following and following['role'] == 'agent' else None
        out.append(
            {
                'index': len(out),
                'history': said[:index],
                'customer': message['text'],
                'prodReply': logs.as_seen(reply) if reply is not None else None,
            }
        )
    return out


def of_family(family: str, rules: list[dict]) -> list[dict]:
    """A check's rules under ids of their own family: tone and accuracy number their rules independently."""
    return [{**rule, 'id': f'{family}:{rule["id"]}', 'family': family} for rule in rules]


async def criteria_by_dialogue(dialogues: list[dict]) -> dict[str, list[dict]]:
    """Every dialogue's criteria: tone of voice, its accuracy topic's rules, the knowledge-base ones."""
    tone_rules = _tone_rules()
    accuracy = store.load(discover.RESULT) or {}
    topics = await discover.keep_topics(accuracy, dialogues) if accuracy.get('topics') else []
    topic_of = {dialogue_id: topic for topic in topics for dialogue_id in topic['dialogueIds']}
    return {
        str(d['id']): [
            *tone_rules,
            *of_family('code', (topic_of.get(str(d['id'])) or {}).get('rules') or []),
            *rag.CRITERIA,
        ]
        for d in dialogues
    }


def _tone_rules() -> list[dict]:
    found = tone.rules()
    draft = found[1] if found else None
    return of_family('tone', [tone.for_judging(rule) for rule in draft['criteria']]) if draft else []
