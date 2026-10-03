"""The two checks of the real conversations, and the one way to find a check's result.

- tone: Tone of voice, by the criteria from the person's communication rules (tone.py);
- code: Точность, by the criteria from the agent's prompts and tools (discover.py).
Each keeps its own criteria, result and answers: neither replaces the other, and their counts never add up. Imports
nothing of the Lab, so storage can use it too.
"""

TONE, CODE = 'tone', 'code'
RESULTS = {TONE: 'tone-result.json', CODE: 'discover.json'}
NAMES = {TONE: 'Tone of voice', CODE: 'Точность'}


def result(check: str) -> str:
    """The document that holds the check's result."""
    return RESULTS[check]
