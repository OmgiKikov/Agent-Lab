#!/usr/bin/env python3
"""Reference command adapter for Agent Lab: run a local Python agent without any HTTP.

Agent Lab starts this script once per dialogue and speaks JSON lines:
  stdin  -> {"type": "respond", "sessionId": ..., "scenarioId": ..., "initialState": {...}, "messages": [...], "message": "..."}
  stdout <- "plain reply"  or  {"reply": "...", "events": [{"tool": ..., "args": ..., "result": ...}], "records": {...},
             "retrievals": [{"source": "...", "content": "exact chunk", "score": 0.8}], "retrievalsComplete": true}
  stdin  -> {"type": "close", "sessionId": ...}   (then stdin ends)

Replace `handle` with a call into your RAG agent. Keep one reply per request and flush stdout.
stdout carries the protocol: the reply to a request is the next line of JSON. Print debugging to stderr
(`log` below). A stray line on stdout that is not JSON — a print() left in your agent or a library's banner —
does not break the dialogue: Agent Lab keeps it with stderr as diagnostics, and it shows in the reason when a
reply fails. A stray line that is JSON would be taken for the reply, so keep JSON off stdout except the reply.
"retrievals" are the exact knowledge-base chunks given to the model for this reply; set
retrievalsComplete=true only when the list is the whole context. Without them Agent Lab cannot tell
a search miss from a bad answer, and the RAG diagnosis stays silent.

initialState may carry "external": opaque data for your test environment (cards, contracts, tool fixtures).
Apply it before the first reply and keep resetConfirmed=True only if you did; Agent Lab treats an
unconfirmed external state as an invalid (unmeasured) dialogue, never as a pass.
"""
import json
import re
import sys


def log(*values):
    """Diagnostics go to stderr: Agent Lab shows them when a dialogue fails, and stdout stays the protocol."""
    print(*values, file=sys.stderr, flush=True)


def handle(request, records):
    message = request["message"]
    match = re.search(r"\b(?:[01]\d|2[0-3]):[0-5]\d\b", message)
    if records and match:
        record_id = next(iter(records))
        before = dict(records[record_id])
        records[record_id]["time"] = match.group(0)
        return {
            "reply": f"Moved {record_id} to {match.group(0)}.",
            "events": [
                {"tool": "lookup_record", "args": {"recordId": record_id}, "result": {"ok": True, "recordId": record_id, "record": before}},
                {"tool": "update_record", "args": {"recordId": record_id, "changes": {"time": match.group(0)}}, "result": {"ok": True, "recordId": record_id, "record": records[record_id]}},
            ],
            "records": records,
        }
    return {"reply": f"You said: {message}", "events": [], "records": records}


records = None  # One process per dialogue: retain state until close, then reset in the next process.
applied_external = False
turn = 0
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    request = json.loads(line)
    if request.get("type") == "close":
        break
    if records is None:
        records = json.loads(json.dumps(request["initialState"]["records"]))
        # This echo agent has no backend to load "external" into, so it only confirms a reset it actually performed.
        applied_external = "external" not in request["initialState"]
    turn += 1
    log(f"turn {turn}: {len(request['message'])} characters")
    reply = handle(request, records)
    reply.update(eventsComplete=True, resetConfirmed=applied_external, turn=turn, version="echo-python-1",
                 usage={"calls": 0, "inputTokens": 0, "outputTokens": 0, "costUsd": 0})
    if request.get("sessionId"):
        reply["sessionId"] = request["sessionId"]
    sys.stdout.write(json.dumps(reply, ensure_ascii=False) + "\n")
    sys.stdout.flush()
