"""The two checks of the real conversations, and the one way to find a check's result.

- tone: Tone of voice, by the criteria from the person's communication rules (tone.py);
- code: Точность, by the criteria from the agent's prompts and tools (discover.py).
Each keeps its own criteria, result and answers: neither replaces the other, and their counts never add up. Imports
nothing of the Lab, so storage can use it too.
"""

TONE, CODE = 'tone', 'code'
RESULTS = {TONE: 'tone-result.json', CODE: 'discover.json'}
NAMES = {TONE: 'Tone of voice', CODE: 'Точность'}
# What marks tone of voice's own: the kind and id of its policy, so its criteria's sourceId (tone.KIND), and the title
# of its only topic, which its scenarios and their conversations carry.
TONE_OF_VOICE, TONE_TOPIC = 'tone-of-voice', 'Tone of voice'


def result(check: str) -> str:
    """The document that holds the check's result."""
    return RESULTS[check]


def of_run(record: dict) -> str:
    """A run's check: the one it remembers, else (a run played before runs remembered it) the one of its criteria:
    quoted from the communication rules, or played in tone of voice's topic, they are tone of voice's."""
    if record.get('check') in RESULTS:
        return record['check']
    for item in record.get('items') or []:
        criteria = item.get('criteria') if isinstance(item.get('criteria'), list) else []
        if item.get('topic') == TONE_TOPIC or any(criterion.get('sourceId') == TONE_OF_VOICE for criterion in criteria):
            return TONE
    return CODE
