"""Raindrop Workshop as the trace viewer: OTLP JSON spans + its local REST API.

Every Lab conversation becomes one Workshop run (run id == trace id), streamed
turn by turn so the conversation appears live. Workshop is optional: when it is
not running, the Lab keeps working and simply has no trace links.
"""

import contextlib
import json
import secrets
import time

import httpx

from .settings import WORKSHOP_URL as URL

EVENT = 'agent-lab'


def available() -> bool:
    try:
        return httpx.get(URL + '/health', timeout=2).status_code == 200
    except httpx.HTTPError:
        return False


def _value(v):
    if isinstance(v, bool):
        return {'boolValue': v}
    if isinstance(v, int):
        return {'intValue': str(v)}
    if isinstance(v, float):
        return {'doubleValue': v}
    if not isinstance(v, str):
        v = json.dumps(v, ensure_ascii=False)
    return {'stringValue': v}


def _ns() -> int:
    return time.time_ns()


class Trace:
    """One Workshop run. Spans are posted as soon as they end."""

    def __init__(self, name: str, convo_id: str, user_id: str, properties: dict, enabled: bool = True):
        self.trace_id = secrets.token_hex(16)
        self.root_id = secrets.token_hex(8)
        self.name = name
        self.started = _ns()
        self.enabled = enabled
        self.base = {
            'traceloop.association.properties.event_id': self.trace_id,
            'traceloop.association.properties.event_name': EVENT,
            'traceloop.association.properties.user_id': user_id,
            'traceloop.association.properties.convo_id': convo_id,
        }
        self.properties = properties
        self.named = False

    @property
    def run_id(self) -> str:
        return self.trace_id

    @property
    def url(self) -> str:
        return f'{URL}/runs/{self.trace_id}'

    def _post(self, spans: list[dict]) -> None:
        if not self.enabled:
            return
        body = {
            'resourceSpans': [
                {
                    'resource': {'attributes': [{'key': 'service.name', 'value': {'stringValue': 'agent-lab'}}]},
                    'scopeSpans': [{'scope': {'name': 'agent-lab'}, 'spans': spans}],
                }
            ]
        }
        try:
            httpx.post(URL + '/v1/traces', json=body, timeout=5)
            if not self.named:
                self.named = self.rename(self.name)
        except httpx.HTTPError:
            self.enabled = False

    def span(self, name: str, kind: str, start: int, attrs: dict, error: str | None = None) -> None:
        attributes = {**self.base, 'raindrop.span.kind': kind, **attrs}
        self._post(
            [
                {
                    'traceId': self.trace_id,
                    'spanId': secrets.token_hex(8),
                    'parentSpanId': self.root_id,
                    'name': name,
                    'kind': 1,
                    'startTimeUnixNano': str(start),
                    'endTimeUnixNano': str(max(_ns(), start + 1_000_000)),
                    'attributes': [{'key': k, 'value': _value(v)} for k, v in attributes.items() if v is not None],
                    'status': {'code': 2, 'message': error} if error else {'code': 1},
                }
            ]
        )

    def agent_turn(self, start: int, history: list[dict], reply: str, model: str, error: str | None = None) -> None:
        """An agent reply rendered by Workshop as a chat turn (user message -> agent answer)."""
        self.span(
            'Агент отвечает',
            'llm_call',
            start,
            {
                'traceloop.span.kind': 'llm',
                'traceloop.entity.input': json.dumps(history, ensure_ascii=False),
                'traceloop.entity.output': reply,
                'gen_ai.request.model': model,
            },
            error,
        )

    def tool(self, name: str, start: int, payload_in, payload_out, error: str | None = None) -> None:
        self.span(
            name,
            'tool_call',
            start,
            {
                'tool.name': name,
                'traceloop.span.kind': 'tool',
                'traceloop.entity.input': payload_in
                if isinstance(payload_in, str)
                else json.dumps(payload_in, ensure_ascii=False),
                'traceloop.entity.output': payload_out
                if isinstance(payload_out, str)
                else json.dumps(payload_out, ensure_ascii=False),
            },
            error,
        )

    def finish(self, output: str) -> None:
        props = {f'traceloop.association.properties.{k}': v for k, v in self.properties.items()}
        self._post(
            [
                {
                    'traceId': self.trace_id,
                    'spanId': self.root_id,
                    'name': self.name,
                    'kind': 1,
                    'startTimeUnixNano': str(self.started),
                    'endTimeUnixNano': str(_ns()),
                    'attributes': [
                        {'key': k, 'value': _value(v)}
                        for k, v in {
                            **self.base,
                            **props,
                            'raindrop.span.kind': 'agent_root',
                            'traceloop.entity.output': output,
                        }.items()
                    ],
                    'status': {'code': 1},
                }
            ]
        )

    def rename(self, name: str) -> bool:
        return self.enabled and rename(self.trace_id, name)

    def annotate(self, kind: str, note: str) -> None:
        if self.enabled:
            annotate(self.trace_id, kind, note)

    def save_to(self, folder: str, user_input: str, output: str, summary: str) -> None:
        """Pin the run into a Saved folder so it survives a Workshop 'clear'."""
        if not self.enabled:
            return
        try:
            detail = None
            for _ in range(10):
                response = httpx.get(f'{URL}/api/runs/detail/{self.trace_id}', timeout=5)
                if response.status_code == 200:
                    detail = response.json()
                    break
                time.sleep(0.2)
            if detail is None:
                return
            httpx.put(f'{URL}/api/saved-runs/cache/{self.trace_id}', json=detail, timeout=5)
            httpx.put(
                f'{URL}/api/saved-runs/events/{self.trace_id}',
                json={
                    'event_name': EVENT,
                    'timestamp': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
                    'user_id': self.base['traceloop.association.properties.user_id'],
                    'convo_id': self.base['traceloop.association.properties.convo_id'],
                    'user_input': user_input,
                    'assistant_output': output,
                    'properties': self.properties,
                    'summary': summary,
                    'source': 'local',
                    'folder': folder,
                },
                timeout=5,
            )
        except httpx.HTTPError:
            pass


# Workshop accepts only user/claude-code/codex as a note author; the Agent Lab section of the
# UI shows notes carrying this prefix as "Судья · Agent Lab".
LAB_NOTE_MARK = '[agent-lab] '


def kind_of(status: str) -> str:
    """Workshop's annotation kind for a verdict: a failure is an issue, anything else a note."""
    return 'issue' if status == 'FAIL' else 'note'


def annotate(run_id: str, kind: str, note: str, replace: bool = False) -> None:
    try:
        if replace:
            for old in httpx.get(URL + '/api/annotations', params={'run_id': run_id}, timeout=5).json():
                if old.get('source') == 'codex':
                    httpx.delete(f'{URL}/api/annotations/{old["id"]}', timeout=5)
        httpx.post(
            URL + '/api/annotations',
            json={'run_id': run_id, 'kind': kind, 'source': 'codex', 'note': LAB_NOTE_MARK + note},
            timeout=5,
        )
    except (httpx.HTTPError, ValueError):
        pass


def rename(run_id: str, name: str) -> bool:
    try:
        return httpx.patch(f'{URL}/api/runs/{run_id}', json={'name': name[:200]}, timeout=5).status_code == 200
    except httpx.HTTPError:
        return False


def forget(run_id: str) -> None:
    """Remove one Lab trace from Workshop, including its Saved entry."""
    for path in (f'/api/saved-runs/events/{run_id}', f'/api/saved-runs/cache/{run_id}', f'/api/runs/{run_id}'):
        with contextlib.suppress(httpx.HTTPError):
            httpx.delete(URL + path, timeout=5)
