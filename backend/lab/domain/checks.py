"""The two checks of the real conversations, and the one way to find a check's result.

- tone: Tone of voice, by the criteria from the person's communication rules (flows/tone.py);
- code: Точность, by the criteria from the agent's prompts and tools (flows/accuracy.py).
Each keeps its own criteria, result and answers: neither replaces the other, and their counts never add up. Imports
nothing of the Lab, so storage can use it too.
"""

TONE, CODE = 'tone', 'code'
RESULTS = {TONE: 'tone-result.json', CODE: 'discover.json'}
NAMES = {TONE: 'Tone of voice', CODE: 'Точность'}
DECK = 'cards.json'  # the scenarios of one check: {check, createdAt, model, cards, sets, catalogRevision}
# The catalog of business scenarios (domain/catalog.py): {revision, builtAt, model, categories, totals, episodes}.
# Built from the export alone: neither check's result nor criteria change it.
CATALOG = 'catalog.json'
# The criteria of Точность waiting for its next check after a new export: its topics and their criteria without the
# conversations of the old export (flows.inputs.replace_export, accuracy.criteria_of); changed code clears them.
CODE_CRITERIA = 'accuracy-criteria.json'
# Serious and minor errors, per check, by the criterion's key (problems.rule_key): a person's decisions
# {tone: {key: true|false}, code: {…}} (an older record listed only the serious keys), and apart from them the model's
# proposals {tone: {proposals: {key: {serious, reason}}, model, at, error}, code: {…}} (flows/severity.py), which never
# touch a decision. Both apart from the criteria: severity changes neither what is checked nor how, so it makes no new
# version of the criteria.
SEVERITY = 'severity.json'
SEVERITY_PROPOSED = 'severity-proposed.json'
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


def separated(documents: dict) -> dict:
    """What changes in the documents of the time when both checks shared one result (discover.json): a tone-of-voice
    result there moves to its own place, unless one is there already; a deck from before decks named their check gets
    the check of the result in the shared place, which it was built from (a deck built without a check names None and
    stays so). Only the documents that change; none the second time."""
    shared = documents.get(RESULTS[CODE])
    tone = isinstance(shared, dict) and shared.get('purpose') == TONE_OF_VOICE
    changes = {}
    deck = documents.get(DECK)
    if isinstance(deck, dict) and 'check' not in deck:
        changes[DECK] = deck | {'check': TONE if tone else CODE}
    if tone and not documents.get(RESULTS[TONE]):
        changes |= {RESULTS[TONE]: shared, RESULTS[CODE]: None}
    return changes
