"""What the Lab keeps, in one SQLite database per agent (registry.py), by what is kept:

- documents: the inputs, drafts, settings, the deck and the current result of each check, each one JSON document;
- dialogues: the export's conversations, one row each;
- runs: the runs of scenarios, each with its conversations and verdicts;
- history: the saved checks of both checks;
- reviews: the answers people gave on verdicts, one row each, a journal;
- severity: which criteria's errors are serious, a person's decisions and the model's proposals;
- calls: the journal of calls to the models.

Storage knows nothing of the processes: what a new input resets, when a result goes to the history, is decided in
flows/, which holds a transaction (transaction) around the writes one change makes. The tables and how an older
database becomes them: schema.py.
"""

from . import calls, db, dialogues, documents, history, registry, reviews, runs, severity
from .db import now, transaction

__all__ = [
    'calls',
    'db',
    'dialogues',
    'documents',
    'history',
    'now',
    'registry',
    'reviews',
    'runs',
    'severity',
    'transaction',
]
