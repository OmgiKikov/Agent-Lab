"""Serious and minor errors, per check, by the criterion's key (domain.problems.rule_key): a person's decisions
(checks.SEVERITY) and, apart from them, the model's proposals (checks.SEVERITY_PROPOSED), which never touch a decision.
Both are documents apart from the criteria: severity changes neither what is checked nor how."""

import hashlib
import sqlite3
from typing import Any

from ..domain import checks
from . import db, documents


def marks() -> dict[str, dict[str, bool]]:
    """A person's decisions per check: a criterion's key and whether its errors are serious."""
    with db.connect() as connection:
        return _of(connection)[0]


def proposed() -> dict[str, dict]:
    """The model's proposals per check: by key {serious, reason}, which model, when, and why the last one failed."""
    with db.connect() as connection:
        return _of(connection)[1]


def serious() -> dict[str, list[str]]:
    """The criteria whose errors are serious, per check: a person's decision, else the model's proposal; without
    either an error is minor."""
    with db.connect() as connection:
        return _serious(*_of(connection))


def stamp() -> str:
    """What changes with any decision or proposal, also one that leaves the same criteria serious (a person confirmed a
    proposal): the screens ask for the problems again by it."""
    with db.connect() as connection:
        found = _of(connection)
    return hashlib.sha1(db.dump(list(found)).encode()).hexdigest()[:12]


def decide(check: str, rule: str, is_serious: bool) -> dict[str, list[str]]:
    """A person decides whether the errors of one criterion of a check are serious; no proposal ever changes it. The
    serious criteria of every check after it."""
    with db.transaction(), db.connect() as connection:
        decided, found = _of(connection)
        decided[check][rule] = is_serious
        documents.put(connection, checks.SEVERITY, decided)
        return _serious(decided, found)


def confirm(check: str, keys: list[str]) -> dict[str, list[str]]:
    """A person takes the model's proposals for these criteria as their own decisions; a criterion the person decided
    already or the model has not proposed for stays as it is."""
    with db.transaction(), db.connect() as connection:
        decided, found = _of(connection)
        proposals = found[check]['proposals']
        for key in keys:
            if key not in decided[check] and key in proposals:
                decided[check][key] = proposals[key]['serious']
        documents.put(connection, checks.SEVERITY, decided)
        return _serious(decided, found)


def propose(check: str, proposals: dict[str, dict], model: str | None) -> None:
    """The model's proposals for some criteria of a check, beside the ones it made before; the last failure is over."""
    with db.transaction(), db.connect() as connection:
        found = _of(connection)[1]
        found[check] = {
            'proposals': found[check]['proposals'] | proposals,
            'model': model,
            'at': db.now(),
            'error': None,
        }
        documents.put(connection, checks.SEVERITY_PROPOSED, found)


def failed(check: str, error: str) -> None:
    """Why the model's last proposal for a check failed; what it proposed before stays."""
    with db.transaction(), db.connect() as connection:
        found = _of(connection)[1]
        found[check] = found[check] | {'error': error, 'at': db.now()}
        documents.put(connection, checks.SEVERITY_PROPOSED, found)


def take(check: str, decided: dict[str, bool], proposals: dict) -> None:
    """A check's decisions and proposals as another agent has them (the rules of communication taken as a copy,
    flows.tone.copy)."""
    with db.transaction(), db.connect() as connection:
        own_marks, own_proposed = _of(connection)
        documents.put(connection, checks.SEVERITY, own_marks | {check: dict(decided)})
        documents.put(connection, checks.SEVERITY_PROPOSED, own_proposed | {check: _proposed(proposals)})


def _of(connection: sqlite3.Connection) -> tuple[dict[str, dict[str, bool]], dict[str, dict]]:
    decided = documents.get(connection, checks.SEVERITY) or {}
    found = documents.get(connection, checks.SEVERITY_PROPOSED) or {}
    return (
        {check: _marks(decided.get(check)) for check in checks.RESULTS},
        {check: _proposed(found.get(check)) for check in checks.RESULTS},
    )


def _marks(value: Any) -> dict[str, bool]:
    """A person's decisions of one check: a criterion's key and whether its errors are serious. An older record listed
    only the keys marked serious."""
    if isinstance(value, list):
        return {key: True for key in value if isinstance(key, str)}
    if isinstance(value, dict):
        return {key: is_serious for key, is_serious in value.items() if isinstance(is_serious, bool)}
    return {}


def _proposed(value: Any) -> dict:
    """The model's proposals of one check: by key {serious, reason}, which model, when, and why the last one failed."""
    value = value if isinstance(value, dict) else {}
    proposals = value.get('proposals') if isinstance(value.get('proposals'), dict) else {}
    return {
        'proposals': {
            key: {'serious': row['serious'], 'reason': row.get('reason') or ''}
            for key, row in proposals.items()
            if isinstance(row, dict) and isinstance(row.get('serious'), bool)
        },
        'model': value.get('model'),
        'at': value.get('at'),
        'error': value.get('error'),
    }


def _serious(decided: dict[str, dict[str, bool]], found: dict[str, dict]) -> dict[str, list[str]]:
    result = {}
    for check in checks.RESULTS:
        merged = {key: row['serious'] for key, row in found[check]['proposals'].items()} | decided[check]
        result[check] = sorted(key for key, is_serious in merged.items() if is_serious)
    return result
