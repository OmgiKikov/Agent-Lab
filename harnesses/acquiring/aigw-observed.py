#!/usr/bin/env python3
"""AIGW local adapter with PostgreSQL observation and correlated IDP/SBE traces.

Run with aigw-local's .venv Python and its project path as the only argument.
Each dialogue gets a new conversation ID. The database must contain neither cache
nor surface_cache rows for that ID before the first request. Only those rows are read;
no existing dialogue is deleted or overwritten by reset. IDP/SBE are local fixtures.
Business-system state and model token/cost accounting are not exposed by this API.

What an answer shows about the agent's outcome is read by aigw-local's own module
local/agent_lab_target.py: `ask` sends a message, and the mapping of an answer's outcome and
events to observed records is `observed` there. aigw-local has so far published that mapping
only under the private name `_observed`; the harness never edits the agent under test, and
copying the mapping here would let the two drift apart silently, so it takes the public name
when there is one and the private one otherwise — and refuses with a clear message when
neither exists, instead of failing on an import.
"""
import json
import os
import sys
from pathlib import Path
from types import ModuleType
from typing import Any, Callable
from uuid import UUID


def observer(target: ModuleType) -> Callable[..., Any]:
    """The mapping of an answer to observed records in aigw-local's module: the public name first."""
    found = getattr(target, "observed", None) or getattr(target, "_observed", None)
    if not callable(found):
        raise SystemExit("aigw-observed: в local/agent_lab_target.py aigw-local нет функции observed (или _observed) — "
                         "обвязка не знает, как читать исход ответа. Обновите обвязку под эту версию aigw-local.")
    return found


def main():
    sys.path.insert(0, str(Path(sys.argv[1]).resolve()))
    import httpx
    import psycopg2
    from psycopg2 import sql
    import local.agent_lab_target as target

    ask, observed = target.ask, observer(target)
    database = psycopg2.connect(host=os.environ.get("POSTGRES_HOST", "127.0.0.1"), port=os.environ.get("POSTGRES_PORT", "55432"),
                               user=os.environ.get("POSTGRES_LOGIN", "aigw"), password=os.environ.get("DB_PASS", "aigw"),
                               dbname=os.environ.get("POSTGRES_DB_NAME", "aigateway"), connect_timeout=5)
    database.autocommit = True
    schema = sql.Identifier(os.environ.get("POSTGRES_SEARCH_PATH", "ckr_acquiring").strip('"'))
    session_id = None
    turn = 0
    seen = {}

    def snapshot():
        with database.cursor() as cursor:
            cursor.execute(sql.SQL("SELECT EXISTS (SELECT 1 FROM {}.cache WHERE conversation_id = %s)").format(schema), (session_id,))
            cached = cursor.fetchone()[0]
            cursor.execute(sql.SQL("SELECT requests_amount, output FROM {}.surface_cache WHERE dialog_id = %s").format(schema), (session_id,))
            surface = cursor.fetchone()
            return {"cache_exists": cached, "surface_requests": int(surface[0]) if surface else 0, "has_last_output": bool(surface and surface[1])}

    try:
        with httpx.Client() as client:
            for line in sys.stdin:
                request = json.loads(line)
                if request.get("type") == "close":
                    return
                if "prompt" in request:
                    raise ValueError("AIGW HTTP API does not support per-session prompt overrides")
                if turn == 0:
                    session_id = str(UUID(request["sessionId"]))
                    if any(snapshot().values()):
                        raise ValueError("Conversation already exists; choose a fresh session ID")
                    initial = request["initialState"].get("records", {})
                    supported = {"conversation": {"cache_exists": False, "surface_requests": 0, "has_last_output": False}}
                    if initial and initial != supported:
                        raise ValueError("This adapter can only reset a fresh conversation, not business records")
                if request["sessionId"] != session_id:
                    raise ValueError("Session ID changed within a dialogue")
                previous = snapshot()
                if turn and not previous["cache_exists"] and not previous["surface_requests"]:
                    raise ValueError("The service did not persist conversation history")
                answer = ask(client, session_id, request["message"])
                turn += 1
                outcome = observed(answer["outcome"], answer["events"], seen)
                reply = {"reply": answer["reply"], "events": answer["events"], "eventsComplete": True,
                         "eventScope": ["idp_search", "sbe_*", "agent_outcome"], "resetConfirmed": True,
                         "sessionId": session_id, "turn": turn, "records": {"conversation": snapshot(), "outcome": outcome}}
                # Only an explicitly supplied deployment identity is asserted as the remote release.
                if os.environ.get("AGENT_LAB_TARGET_VERSION"):
                    reply["version"] = os.environ["AGENT_LAB_TARGET_VERSION"]
                print(json.dumps(reply, ensure_ascii=False), flush=True)
    finally:
        database.close()


if __name__ == "__main__":
    main()
