#!/usr/bin/env python3
"""Python helper for Agent Lab command adapters (see docs/adapter-contract.md).

Import it (or copy this file) and write one function::

    from agent_lab_adapter import Reply, Retrieval, ToolEvent, serve

    def ask(session_id: str, request: dict) -> Reply:
        answer = my_agent.turn(session_id, request["message"])
        return Reply(reply=answer.text,
                     events=[ToolEvent(c.name, c.args, c.result) for c in answer.tool_calls],
                     retrievals=[Retrieval(d.doc_id, d.text, chunk_id=d.chunk_id, score=d.score) for d in answer.docs],
                     events_complete=True, retrievals_complete=True)

    serve(ask)

`serve` speaks the JSON-lines protocol: one process per dialogue, one reply per request, "close" ends it.
Set a completeness flag only when your code sees the whole turn; an unset flag leaves the check unmeasured,
which is honest, while a wrong one turns a missed call or article into a false verdict.

Run directly, this file is a level-2 demo: a toy RAG over two articles.
"""

from __future__ import annotations

import json
import re
import sys
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Sequence


@dataclass(frozen=True)
class Retrieval:
    source: str
    content: str
    chunk_id: Optional[str] = None
    score: Optional[float] = None

    def to_wire(self) -> Dict[str, Any]:
        wire: Dict[str, Any] = {"source": self.source}
        if self.chunk_id is not None:
            wire["chunkId"] = self.chunk_id
        wire["content"] = self.content
        if self.score is not None:
            wire["score"] = self.score
        return wire


@dataclass(frozen=True)
class ToolEvent:
    tool: str
    args: Any = None
    result: Any = None

    def to_wire(self) -> Dict[str, Any]:
        wire: Dict[str, Any] = {"tool": self.tool}
        if self.args is not None:
            wire["args"] = self.args
        if self.result is not None:
            wire["result"] = self.result
        return wire


@dataclass(frozen=True)
class Reply:
    reply: str
    events: Sequence[ToolEvent] = ()
    retrievals: Sequence[Retrieval] = ()
    event_scope: Sequence[str] = ()
    events_complete: bool = False
    retrievals_complete: bool = False
    reset_confirmed: bool = False
    records: Optional[Dict[str, Dict[str, Any]]] = None
    version: Optional[str] = None
    usage: Optional[Dict[str, Any]] = None
    extra: Dict[str, Any] = field(default_factory=dict)

    def to_wire(self) -> Dict[str, Any]:
        wire: Dict[str, Any] = {"reply": self.reply, "events": [event.to_wire() for event in self.events]}
        if self.retrievals or self.retrievals_complete:
            wire["retrievals"] = [chunk.to_wire() for chunk in self.retrievals]
        optional = {
            "eventScope": list(self.event_scope) or None,
            "eventsComplete": self.events_complete or None,
            "retrievalsComplete": self.retrievals_complete or None,
            "resetConfirmed": self.reset_confirmed or None,
            "records": self.records,
            "version": self.version,
            "usage": self.usage,
        }
        wire.update({key: value for key, value in optional.items() if value is not None})
        wire.update(self.extra)
        return wire


def serve(ask: Callable[[str, Dict[str, Any]], Reply]) -> None:
    turn = 0
    for line in sys.stdin:
        if not line.strip():
            continue
        request = json.loads(line)
        if request.get("type") == "close":
            break
        turn += 1
        wire = ask(request.get("sessionId", ""), request).to_wire()
        wire["turn"] = turn
        sys.stdout.write(json.dumps(wire, ensure_ascii=False) + "\n")
        sys.stdout.flush()


KNOWLEDGE_BASE = (
    Retrieval("KB-1", "Возврат по эквайрингу занимает до 5 рабочих дней.", chunk_id="KB-1#1"),
    Retrieval("KB-2", "Комиссия за эквайринг 1.5% от суммы операции.", chunk_id="KB-2#1"),
)


def _words(text: str) -> set:
    return set(re.findall(r"[^\W_]{4,}", text.lower()))


def _search(query: str) -> List[Retrieval]:
    asked = _words(query)
    scored = [Retrieval(chunk.source, chunk.content, chunk.chunk_id, len(_words(chunk.content) & asked)) for chunk in KNOWLEDGE_BASE]
    return sorted((chunk for chunk in scored if chunk.score), key=lambda chunk: -(chunk.score or 0))


def demo_ask(session_id: str, request: Dict[str, Any]) -> Reply:
    found = _search(request["message"])
    return Reply(
        reply=found[0].content if found else "В базе знаний нет ответа на этот вопрос.",
        events=[ToolEvent("search_kb", {"query": request["message"]}, {"docIds": [chunk.source for chunk in found]})],
        retrievals=found,
        event_scope=["search_kb"],
        events_complete=True,
        retrievals_complete=True,
        reset_confirmed="external" not in (request.get("initialState") or {}),
        version="reference-python-1",
    )


if __name__ == "__main__":
    serve(demo_ask)
