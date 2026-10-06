"""What the Lab keeps, in one SQLite database per agent (registry.py), by what is kept:

- documents: the inputs, drafts, settings, the deck and the current result of each check, each one JSON document;
- exports, dialogues: the exports of real conversations, each upload one, and their conversations, one row each;
- runs: the runs of scenarios, each with its conversations and verdicts;
- replays: the checks of the live agent on the same customers, each with its conversations and verdicts;
- history: the saved checks of both checks;
- reviews: the answers people gave on verdicts, one row each, a journal;
- severity: which criteria's errors are serious, a person's decisions and the model's proposals;
- calls: the journal of calls to the models;
- tasks: the long work, kept as it goes (what was started, how far it got, its finished parts).

Storage knows nothing of the processes: what a new input resets, when a result goes to the history, is decided in
flows/, which holds a transaction (transaction) around the writes one change makes. The tables and how an older
database becomes them: schema.py.
"""

from . import calls, db, documents, exports, history, registry, replays, reviews, runs, severity, tasks
from .db import now, transaction

__all__ = [
    'calls',
    'db',
    'documents',
    'exports',
    'history',
    'now',
    'registry',
    'replays',
    'reviews',
    'runs',
    'severity',
    'tasks',
    'transaction',
]
