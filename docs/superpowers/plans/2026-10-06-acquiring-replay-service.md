# Сервис повтора агента эквайринга на стенде — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** поднять агента эквайринга как отдельный сервис повтора (`POST /replay/turn` → ответ агента + трейс шага) без записи во внешние системы, с промптами из MLS и прогретым кэшем IDP, и научить Lab повторять разговоры через него и отдавать Judge'у ответ повтора, ответ прода и трейс.

**Architecture:** в aigw-local новый пакет `replay/` рядом с `src/`. Он выключает побочные эффекты агента (`isolation.py`), записывает трейс запроса (`recorder.py`, переезжает из `local/`), отвечает за SBE из фикстур (`sbe_stub.py`) и вызывает приложение агента внутри процесса через `httpx.ASGITransport` (`api.py`). `src/` возвращается к чистому снимку `2bf2e31`. В Lab новый target `replay-service` (`agents/replay_service.py`), критерий `replay:match` (`match.py`), Judge получает `replayReply` и `prodReply`.

**Tech Stack:** aigw-local — Python 3.12, FastAPI, httpx, LangChain core, unittest. Lab — Python 3.11, FastAPI, httpx, unittest; React + TypeScript + Tailwind.

**Спека:** `docs/superpowers/specs/2026-10-06-acquiring-replay-service-design.md`.

---

## Карта файлов

**aigw-local** (`/Users/alexander/Работа/SberAI Lab/aigw-local`, ветка `feat/replay-service`):
- Create `replay/__init__.py`, `replay/tests/__init__.py` — пакет сервиса повтора и его тесты.
- Move `local/agent_lab_trace.py` → `replay/recorder.py` — запись трейса: цепочки, IDP (+ кэш), SBE, `seq`, статусы.
- Move `local/test_agent_lab_trace.py` → `replay/tests/test_recorder.py`.
- Move `local/agent_lab_memory_db.py` → `replay/memory_db.py`, тест → `replay/tests/test_memory_db.py`.
- Create `replay/sbe_stub.py` + `replay/tests/test_sbe_stub.py` — ответы SBE из фикстур внутри процесса.
- Create `replay/prompts.py` + `replay/tests/test_prompts.py` — какие промпты прочитаны из MLS.
- Create `replay/readiness.py` + `replay/tests/test_readiness.py` — `/health`, прогрев кэша IDP.
- Create `replay/isolation.py` + `replay/tests/test_isolation.py` — выключатели побочных эффектов.
- Create `replay/api.py` + `replay/tests/test_api.py` — `POST /replay/turn`, `GET /health`.
- Create `replay/app.py`, `replay/run.sh`, `replay/replay.env.example` — точка входа и запуск.
- Create `replay/tests/test_against_mocks.py` — проверка запущенного сервиса на заглушках.
- Create `Dockerfile.replay`.
- Modify `local/agent_lab_app.py` — запись через `replay.recorder.record_agent`.
- Modify `local/mocks/server.py` — SBE отвечает через `replay.sbe_stub.answer`.
- Modify `LOCAL.md` — раздел о сервисе повтора.
- Revert `src/`, `local_env` → `2bf2e31`.

**Lab** (`conductor-playground`, ветка `feat/voice360-replay-traces`):
- Create `backend/lab/match.py` + `backend/tests/test_match.py` — критерий «совпадение с продом».
- Modify `backend/lab/rag.py` — что Judge видит из трейса, критерий `rag:grounded`.
- Modify `backend/lab/judge.py`, `backend/lab/prompts.py` — `replayReply`, `prodReply`, статус без `replay:match`.
- Modify `backend/lab/replay.py` — `traced`, критерий совпадения, данные стенда в результате.
- Create `backend/lab/agents/replay_service.py` + `backend/tests/test_replay_service.py`.
- Modify `backend/lab/settings.py`, `backend/lab/agents/__init__.py`, `backend/lab/agents/http.py`, `backend/lab/api.py`.
- Modify `frontend/src/lab/types.ts`, `frontend/src/lab/replay.ts`, `frontend/src/sections/replay/ReplayPage.tsx`, `frontend/src/sections/replay/StepView.tsx`.
- Modify `bin/replay_env_report.py`.

Команды агента выполняются из корня `aigw-local`, команды Lab — из корня `conductor-playground`.

Тесты агента: `PYTHONPATH=local/stubs:src:. .venv/bin/python -m unittest discover -s replay/tests -t . -v`
(в тексте ниже — **`RT`**). `.env` агента на ноутбуке — ссылка на `local/env.local`.

Тесты Lab: `uv run --locked --directory backend python -m unittest discover -s tests -v`.

---

## Часть A. aigw-local

### Task 0: Подготовка ветки

**Files:** нет.

- [ ] **Step 1: Разобраться с незакоммиченной работой**

Run: `git status --short`

Expected сейчас:
```
 M local/agent_lab_target.py
 M local/env.local
 M local/mocks/server.py
 M local/test_agent_lab_target.py
?? local/kb/
?? local/langwatch_target.py
?? local/mocks/fixtures/kb_gigar.json
```
Это работа пользователя (поиск по базе знаний в моке IDP, мост LangWatch). **Спросите пользователя**, закоммитить её в
`feat/agent-lab-trace` или убрать в stash. `local/mocks/fixtures/kb_gigar.json` весит 55 МБ: в git его не добавлять
без явного согласия. Дальше нужен чистый `git status`.

- [ ] **Step 2: Ветка**

```bash
git switch feat/agent-lab-trace
git switch -c feat/replay-service
```

- [ ] **Step 3: Текущие тесты обвязки проходят**

Run: `PYTHONPATH=local/stubs:src .venv/bin/python -m unittest local.test_agent_lab_trace local.test_agent_lab_memory_db local.test_agent_lab_target -v`
Expected: `OK`.

---

### Task 1: Пакет `replay/` и перенос записи трейса

Только перенос, поведение не меняется.

**Files:**
- Create: `replay/__init__.py`, `replay/tests/__init__.py`
- Move: `local/agent_lab_trace.py` → `replay/recorder.py`; `local/test_agent_lab_trace.py` → `replay/tests/test_recorder.py`
- Modify: `local/agent_lab_app.py` (импорт)

- [ ] **Step 1: Пакет**

`replay/__init__.py`:
```python
"""The acquiring agent as a replay service for Agent Lab: one turn of a recorded conversation through the agent with
what happened inside it, nothing written outside the process (spec: conductor-playground
docs/superpowers/specs/2026-10-06-acquiring-replay-service-design.md)."""
```
`replay/tests/__init__.py` — пустой файл.

- [ ] **Step 2: Перенос**

```bash
git mv local/agent_lab_trace.py replay/recorder.py
git mv local/test_agent_lab_trace.py replay/tests/test_recorder.py
```

В `replay/tests/test_recorder.py` заменить первую строку и импорт:
```python
"""Run: PYTHONPATH=local/stubs:src:. .venv/bin/python -m unittest replay.tests.test_recorder -v"""
```
```python
from replay import recorder as trace
```
(вместо `from local import agent_lab_trace as trace`).

В `replay/recorder.py` заменить docstring модуля:
```python
"""What one request did inside the agent: LLM chains, knowledge base (IDP and its cache) and bank systems (SBE),
keyed by the request's x-trace-id. Used by the replay service (replay/app.py) and the local Agent Lab app
(local/agent_lab_app.py); the bank code is not changed."""
```

В `local/agent_lab_app.py` строку
```python
    from local.agent_lab_trace import ChainRecorder, Traces, idp_hook, sbe_hook
```
заменить на
```python
    from replay.recorder import ChainRecorder, Traces, idp_hook, sbe_hook
```

- [ ] **Step 3: Тесты**

Run: `RT`
Expected: `OK` (9 тестов).

Run: `PYTHONPATH=local/stubs:src .venv/bin/python -m unittest local.test_agent_lab_target local.test_agent_lab_memory_db -v`
Expected: `OK`.

- [ ] **Step 4: Commit**

```bash
git add replay local/agent_lab_app.py
git commit -m "replay/: the package of the replay service; the trace recorder moves there from local/"
```

---

### Task 2: Порядок событий (`seq`) и выдача трейса один раз (`take`)

**Files:**
- Modify: `replay/recorder.py` (класс `Traces`, `ChainRecorder.on_chat_model_start`, `idp_hook`, `sbe_hook`)
- Test: `replay/tests/test_recorder.py`

- [ ] **Step 1: Тесты**

В `TracesTest` добавить:
```python
    def test_numbers_events_of_a_request_across_kinds(self):
        traces = trace.Traces()
        traces.add("t", "chains", {"name": "a"})
        traces.add("t", "rag", {"query": "q"})
        traces.add("t", "chains", {"name": "b"})
        found = traces.get("t")
        self.assertEqual(([c["seq"] for c in found["chains"]], [r["seq"] for r in found["rag"]]), ([1, 3], [2]))

    def test_take_gives_the_trace_and_forgets_it(self):
        traces = trace.Traces()
        traces.add("t", "rag", {"query": "q"})
        self.assertEqual(len(traces.take("t")["rag"]), 1)
        self.assertIsNone(traces.get("t"))

    def test_take_of_a_request_without_events_is_an_empty_trace(self):
        self.assertEqual(trace.Traces().take("x"), {"traceId": "x", "chains": [], "rag": [], "systems": []})
```
В `HttpHooksTest.test_records_bank_system_call` ожидание станет:
```python
        self.assertEqual(self.traces.get("t-2")["systems"],
                         [{"seq": 1, "tool": "getLkkTariff", "arguments": {"epk": "1"}, "status": 200}])
```

- [ ] **Step 2: Тесты падают**

Run: `RT`
Expected: FAIL — `AttributeError: 'Traces' object has no attribute 'add'`.

- [ ] **Step 3: Реализация**

Класс `Traces` целиком:
```python
class Traces:
    def __init__(self, limit: int = MAX_TRACES) -> None:
        self._items: OrderedDict[str, dict] = OrderedDict()
        self._numbers: dict[str, int] = {}
        self._limit = limit

    def of(self, trace_id: str) -> dict:
        if trace_id not in self._items:
            self._items[trace_id] = _empty(trace_id)
            while len(self._items) > self._limit:
                oldest, _ = self._items.popitem(last=False)
                self._numbers.pop(oldest, None)
        return self._items[trace_id]

    def add(self, trace_id: str, kind: str, event: dict) -> dict:
        """An event of the request under its next number: seq orders chains, knowledge-base and bank-system calls."""
        trace = self.of(trace_id)
        self._numbers[trace_id] = self._numbers.get(trace_id, 0) + 1
        event["seq"] = self._numbers[trace_id]
        trace[kind].append(event)
        return event

    def get(self, trace_id: str) -> dict | None:
        return self._items.get(trace_id)

    def take(self, trace_id: str) -> dict:
        """The request's trace, forgotten here: the replay service answers with it once (replay/api.py)."""
        self._numbers.pop(trace_id, None)
        return self._items.pop(trace_id, None) or _empty(trace_id)

    def __len__(self) -> int:
        return len(self._items)


def _empty(trace_id: str) -> dict:
    return {"traceId": trace_id, "chains": [], "rag": [], "systems": []}
```
`_empty` поставить к приватным помощникам внизу модуля, рядом с `_json`.

В `ChainRecorder.on_chat_model_start` строку
```python
        self._traces.of(key)["chains"].append(call)
```
заменить на
```python
        self._traces.add(key, "chains", call)
```
В `idp_hook`: `traces.of(key)["rag"].append(call)` → `traces.add(key, "rag", call)`.
В `sbe_hook`: `traces.of(key)["systems"].append({...})` → `traces.add(key, "systems", {...})`.

- [ ] **Step 4: Тесты проходят**

Run: `RT`
Expected: `OK`.

- [ ] **Step 5: Commit**

```bash
git add replay
git commit -m "Every event of a request is numbered across chains, knowledge-base and bank-system calls; a trace can be taken once"
```

---

### Task 3: Вызовы IDP целиком — запрос, ответ, отказ

После отката `src/` (Task 7) заголовок `x-trace-id` к вызовам IDP и SBE больше не добавляет `context.py`. Его ставит
запись, иначе журнал заглушек потеряет ключ запроса.

**Files:**
- Modify: `replay/recorder.py` — удалить `idp_hook` и `rag_call`; добавить `forward_trace_id`, `record_idp`,
  `FailureRecorder`, `rag_question`, `rag_answer`
- Test: `replay/tests/test_recorder.py` — заменить IDP-тесты из `HttpHooksTest`

- [ ] **Step 1: Тесты**

Из `HttpHooksTest` удалить `test_records_rag_query_passages_and_answer`, `test_unexpected_answer_never_breaks_the_agents_call`,
`test_ignores_calls_outside_a_request` (переезжают ниже). Добавить класс:
```python
class IdpRecordingTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.traces = trace.Traces()
        self.current = ContextVar("trace", default=None)

    async def call(self, handler, query: str = "вернуть оборудование") -> httpx.Response:
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler), base_url="http://idp")
        trace.forward_trace_id(client, self.current.get)
        trace.record_idp(client, self.traces, self.current.get)
        async with client:
            return await client.post("/sync/skill/universal_search", json=idp_request(query))

    def only_call(self, key: str) -> dict:
        return self.traces.get(key)["rag"][0]

    async def test_records_the_request_as_sent(self):
        self.current.set("t-1")
        await self.call(lambda request: httpx.Response(200, json=IDP_ANSWER))
        self.assertEqual(self.only_call("t-1")["request"], idp_request("вернуть оборудование"))

    async def test_records_query_filter_and_generation_prompt(self):
        self.current.set("t-1")
        await self.call(lambda request: httpx.Response(200, json=IDP_ANSWER))
        call = self.only_call("t-1")
        self.assertEqual((call["source"], call["query"], call["filter"], call["systemPrompt"]),
                         ("idp", "вернуть оборудование", "*Эквайринг*", "Ответь по {document}"))

    async def test_records_passages_and_answer(self):
        self.current.set("t-1")
        await self.call(lambda request: httpx.Response(200, json=IDP_ANSWER))
        call = self.only_call("t-1")
        self.assertEqual(call["status"], "ok")
        self.assertEqual(call["answer"], "{\"output\": \"Верните терминал в отделение.\"}")
        self.assertEqual(call["passages"], [{"article": "art-1", "passage": 2,
                                             "text": "Терминал возвращают в отделение банка.",
                                             "retrieval": 0.71, "reranker": 0.93}])

    async def test_forwards_the_requests_trace_id(self):
        self.current.set("t-1")
        seen = []

        def answer(request: httpx.Request) -> httpx.Response:
            seen.append(request.headers.get("x-trace-id"))
            return httpx.Response(200, json=IDP_ANSWER)

        await self.call(answer)
        self.assertEqual(seen, ["t-1"])

    async def test_an_error_answer_is_an_error(self):
        self.current.set("t-2")
        await self.call(lambda request: httpx.Response(500, json={}))
        call = self.only_call("t-2")
        self.assertEqual((call["status"], call["httpStatus"]), ("error", 500))

    async def test_a_timeout_is_recorded_and_still_raised(self):
        self.current.set("t-3")

        def slow(request: httpx.Request) -> httpx.Response:
            raise httpx.ReadTimeout("slow", request=request)

        with self.assertRaises(httpx.ReadTimeout):
            await self.call(slow)
        self.assertEqual(self.only_call("t-3")["status"], "timeout")

    async def test_a_cancelled_call_is_recorded(self):
        self.current.set("t-4")
        started = asyncio.Event()

        async def hanging(request: httpx.Request) -> httpx.Response:
            started.set()
            await asyncio.Event().wait()

        task = asyncio.create_task(self.call(hanging))
        await started.wait()
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertEqual(self.only_call("t-4")["status"], "cancelled")

    async def test_unexpected_answer_never_breaks_the_agents_call(self):
        self.current.set("t-5")
        response = await self.call(lambda request: httpx.Response(200, json={"result": "x"}))
        self.assertEqual(response.json(), {"result": "x"})

    async def test_ignores_calls_outside_a_request(self):
        await self.call(lambda request: httpx.Response(200, json=IDP_ANSWER))
        self.assertEqual(len(self.traces), 0)
```

- [ ] **Step 2: Тесты падают**

Run: `RT`
Expected: FAIL — `AttributeError: module 'replay.recorder' has no attribute 'forward_trace_id'`.

- [ ] **Step 3: Реализация**

В импорты `replay/recorder.py` добавить `import asyncio` и `import weakref`. Под `Hook = …` добавить:
```python
RequestHook = Callable[[httpx.Request], Awaitable[None]]

# The trace entry of each IDP call in flight, completed by its answer or by its failure.
_OPEN: "weakref.WeakKeyDictionary[httpx.Request, tuple[dict, float]]" = weakref.WeakKeyDictionary()
```
Удалить функции `idp_hook` и `rag_call`. Добавить (публичные — после `ChainRecorder`, приватные — к помощникам внизу):
```python
def forward_trace_id(client: httpx.AsyncClient, trace_id: TraceId) -> None:
    """The agent's calls carry the request's x-trace-id: the stand's mocks key their journal and test data by it."""
    async def add_header(request: httpx.Request) -> None:
        key = trace_id()
        if key:
            request.headers["x-trace-id"] = key

    _add_hook(client, "request", add_header)


def record_idp(client: httpx.AsyncClient, traces: Traces, trace_id: TraceId) -> None:
    """Every call of the agent's knowledge-base client: what it sent, what came back, or how it failed.
    Modules bound the client at import, so its hooks and transports change, never the client itself."""
    _add_hook(client, "request", _harmless(_open_idp_call(traces, trace_id)))
    _add_hook(client, "response", _harmless(_close_idp_call))
    # httpx has no public seam for a call without an answer: a timeout or a cancelled task never reaches the hooks.
    client._transport = FailureRecorder(client._transport)
    client._mounts = {pattern: FailureRecorder(mounted) if mounted else None
                      for pattern, mounted in client._mounts.items()}


class FailureRecorder(httpx.AsyncBaseTransport):
    """Marks the trace entry of an IDP call that got no answer: timed out, cancelled with its task, or failed."""

    def __init__(self, inner: httpx.AsyncBaseTransport) -> None:
        self._inner = inner

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        try:
            return await self._inner.handle_async_request(request)
        except httpx.TimeoutException:
            _fail(request, "timeout")
            raise
        except asyncio.CancelledError:
            _fail(request, "cancelled")
            raise
        except Exception:
            _fail(request, "error")
            raise

    async def aclose(self) -> None:
        await self._inner.aclose()


def rag_question(request: dict) -> dict:
    """What the agent asked the knowledge base: the question, the articles' filter, the generation prompt."""
    asked = (request.get("message") or {}).get("request") or {}
    question = (asked.get("messages") or [{}])[-1]
    qa = ((request.get("configuration") or {}).get("agent_configuration") or {}).get("qa") or {}
    return {
        "query": question.get("content", ""),
        "filter": (asked.get("filter") or {}).get("value"),
        "systemPrompt": (qa.get("prompts") or {}).get("stuff_system_prompt") or "",
    }


def rag_answer(answer: dict) -> dict:
    """What the knowledge base gave back: passages with their scores, its own answer, why it found nothing."""
    replies = [m for m in (((answer.get("result") or {}).get("response") or {}).get("messages")) or []
               if isinstance(m, dict)]
    last = replies[-1] if replies else {}
    return {
        "passages": [_passage(source) for source in last.get("sources") or [] if isinstance(source, dict)],
        "answer": (last.get("content") or "")[:MAX_TEXT],
        "reason": next((m["message_reason"] for m in replies if m.get("message_reason")), None)
        or answer.get("message_reason"),
    }
```
Приватные помощники:
```python
def _open_idp_call(traces: Traces, trace_id: TraceId) -> RequestHook:
    async def record(request: httpx.Request) -> None:
        key = trace_id()
        if not key:
            return
        body = _json(request.content)
        call = traces.add(key, "rag", {"source": "idp", "status": "pending", "request": body, **rag_question(body),
                                       "passages": [], "answer": "", "reason": None})
        _OPEN[request] = (call, time.monotonic())

    return record


async def _close_idp_call(response: httpx.Response) -> None:
    found = _OPEN.pop(response.request, None)
    if found is None:
        return
    call, started = found
    await response.aread()
    call.update(rag_answer(_json(response.content)), seconds=_since(started))
    if response.is_success:
        call["status"] = "ok"
    else:
        call.update(status="error", httpStatus=response.status_code)


def _fail(request: httpx.Request, status: str) -> None:
    found = _OPEN.pop(request, None)
    if found is not None:
        call, started = found
        call.update(status=status, seconds=_since(started))


def _add_hook(client: httpx.AsyncClient, kind: str, hook: Callable) -> None:
    hooks = client.event_hooks
    client.event_hooks = {**hooks, kind: [*hooks.get(kind, []), hook]}


def _since(started: float) -> float:
    return round(time.monotonic() - started, 2)
```
`_harmless` сделать общим для запроса и ответа (у `httpx.Response` тоже есть `.url`):
```python
def _harmless(record: Callable[[Any], Awaitable[None]]) -> Callable[[Any], Awaitable[None]]:
    """httpx raises a hook's error out of the agent's own call: recording must never change what the agent does."""
    async def hook(message: httpx.Request | httpx.Response) -> None:
        try:
            await record(message)
        except Exception:
            log.exception("Agent Lab could not record a call to %s", message.url)

    return hook
```

- [ ] **Step 4: Локальный запуск на новой записи IDP**

В `local/agent_lab_app.py` импорт:
```python
    from replay.recorder import ChainRecorder, Traces, forward_trace_id, record_idp, sbe_hook
```
строку `_add_response_hook(APP_CTX.idp_client, idp_hook(traces, trace_id))` заменить на:
```python
    for client in (APP_CTX.idp_client, APP_CTX.sbe_client, APP_CTX.sbe_tool_client):
        forward_trace_id(client, trace_id)
    record_idp(APP_CTX.idp_client, traces, trace_id)
```

- [ ] **Step 5: Тесты проходят**

Run: `RT`
Expected: `OK`.

- [ ] **Step 6: Commit**

```bash
git add replay local/agent_lab_app.py
git commit -m "A knowledge-base call is recorded with the request as sent, and a failed, timed-out or cancelled one says so; calls carry the request's x-trace-id"
```

---

### Task 4: SBE из фикстур внутри процесса и ответы SBE в трейсе

**Files:**
- Create: `replay/sbe_stub.py`, `replay/tests/test_sbe_stub.py`
- Modify: `replay/recorder.py` — `sbe_hook` → `record_sbe`; `local/mocks/server.py` — `sbe_execute`
- Test: `replay/tests/test_recorder.py` — заменить `HttpHooksTest` классом `SbeRecordingTest`

- [ ] **Step 1: Тесты заглушки**

`replay/tests/test_sbe_stub.py`:
```python
"""Run: PYTHONPATH=local/stubs:src:. .venv/bin/python -m unittest replay.tests.test_sbe_stub -v"""
import json
import unittest

import httpx

from replay import sbe_stub

TOOLS = {"getLkkTariff": {"responseType": "JSON", "text": {"tariff": "2%"}}}


class AnswerTest(unittest.TestCase):
    def test_a_known_tool_answers_from_its_fixture(self):
        self.assertEqual(sbe_stub.answer(TOOLS, "getLkkTariff"),
                         {"toolName": "getLkkTariff", "text": '{"tariff": "2%"}', "responseType": "JSON"})

    def test_an_unknown_tool_answers_as_sbe_without_data(self):
        self.assertEqual(json.loads(sbe_stub.answer({}, "x")["text"])["code"], 204)

    def test_the_stands_fixtures_load(self):
        self.assertIn("organizationInfoByEpkId", sbe_stub.load())


class TransportTest(unittest.IsolatedAsyncioTestCase):
    async def test_a_call_is_answered_in_process(self):
        async with httpx.AsyncClient(transport=sbe_stub.transport(TOOLS), base_url="https://sbe.bank") as client:
            response = await client.post("/execute", json={"name": "getLkkTariff", "arguments": {}})
        self.assertEqual(response.json()["toolName"], "getLkkTariff")
```

- [ ] **Step 2: Тесты записи SBE**

В `replay/tests/test_recorder.py` удалить класс `HttpHooksTest` целиком (IDP-тесты уже в `IdpRecordingTest`).
Добавить:
```python
TARIFF = {"toolName": "getLkkTariff", "text": "{\"tariff\": \"2%\"}", "responseType": "JSON"}


class SbeRecordingTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.traces = trace.Traces()
        self.current = ContextVar("trace", default=None)

    async def call(self, *, stubbed: bool) -> None:
        transport = httpx.MockTransport(lambda request: httpx.Response(200, json=TARIFF))
        client = httpx.AsyncClient(transport=transport, base_url="http://sbe")
        trace.record_sbe(client, self.traces, self.current.get, stubbed=stubbed)
        async with client:
            await client.post("/execute", json={"name": "getLkkTariff", "arguments": {"epk": "1"}})

    async def test_records_the_tool_its_arguments_and_its_data(self):
        self.current.set("t-1")
        await self.call(stubbed=True)
        self.assertEqual(self.traces.get("t-1")["systems"],
                         [{"seq": 1, "tool": "getLkkTariff", "arguments": {"epk": "1"}, "status": "stubbed",
                           "response": {"tariff": "2%"}}])

    async def test_a_real_system_keeps_its_http_status(self):
        self.current.set("t-2")
        await self.call(stubbed=False)
        self.assertEqual(self.traces.get("t-2")["systems"][0]["status"], 200)
```

- [ ] **Step 3: Тесты падают**

Run: `RT`
Expected: FAIL — `ModuleNotFoundError: No module named 'replay.sbe_stub'` и `AttributeError: … 'record_sbe'`.

- [ ] **Step 4: Заглушка**

`replay/sbe_stub.py`:
```python
"""The bank systems (SBE) answered from fixtures inside this process: the replay service never calls them. The stand's
mock (local/mocks/server.py) answers with the same answer()."""
import json
from pathlib import Path

import httpx

FIXTURES = Path(__file__).resolve().parents[1] / "local" / "mocks" / "fixtures" / "sbe.json"
NO_DATA = {"code": 204, "message": "Нет данных"}


def load(path: Path = FIXTURES) -> dict:
    """The tools' answers by tool name (SBE_TOOL_NAME_*); their shapes follow src/aigw_service/model/sbe_response_model."""
    return json.loads(path.read_text(encoding="utf-8")).get("tools", {})


def answer(tools: dict, tool_name: str) -> dict:
    """SBE's answer to a tool call; an unknown tool answers as SBE does without data (204)."""
    entry = tools.get(tool_name)
    if entry is None:
        return {"toolName": tool_name, "text": json.dumps(NO_DATA, ensure_ascii=False), "responseType": "TEXT"}
    text = entry["text"] if isinstance(entry.get("text"), str) else json.dumps(entry.get("text"), ensure_ascii=False)
    return {"toolName": tool_name, "text": text, "responseType": entry.get("responseType", "TEXT")}


def transport(tools: dict) -> httpx.MockTransport:
    def handle(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content or b"{}")
        return httpx.Response(200, json=answer(tools, body.get("name") or ""))

    return httpx.MockTransport(handle)
```

- [ ] **Step 5: Запись SBE**

В `replay/recorder.py` удалить `sbe_hook`, добавить:
```python
def record_sbe(client: httpx.AsyncClient, traces: Traces, trace_id: TraceId, *, stubbed: bool) -> None:
    """Every bank-system call of the agent with the data it got: the judge checks the reply's customer data
    against it. stubbed: the answers are the replay service's fixtures (replay/sbe_stub.py)."""
    _add_hook(client, "response", _harmless(_sbe_call(traces, trace_id, stubbed)))
```
Помощники:
```python
def _sbe_call(traces: Traces, trace_id: TraceId, stubbed: bool) -> Hook:
    async def record(response: httpx.Response) -> None:
        key = trace_id()
        if not key:
            return
        body = _json(response.request.content)
        await response.aread()
        traces.add(key, "systems", {
            "tool": body.get("name") or body.get("tool") or response.request.url.path,
            "arguments": body.get("arguments", body),
            "status": "stubbed" if stubbed else response.status_code,
            "response": _tool_data(_json(response.content)),
        })

    return record


def _tool_data(answer: dict) -> object:
    """SBE puts a tool's data in text, as JSON when responseType says so."""
    text = answer.get("text")
    if not isinstance(text, str):
        return answer
    if answer.get("responseType") == "JSON":
        try:
            return json.loads(text)
        except ValueError:
            pass
    return text[:MAX_TEXT]
```

- [ ] **Step 6: Мок SBE отвечает тем же `answer()`**

В `local/mocks/server.py` к импортам добавить `from replay import sbe_stub`. Тело `sbe_execute` после разбора
`arguments` заменить на:
```python
    world = _load("sbe.json")
    custom = overrides.get(request.headers.get("x-trace-id"), {}).get("tools", {})
    tools = {**world.get("tools", {}), **custom}

    _log("sbe", {"trace_id": request.headers.get("x-trace-id"), "tool": tool_name, "arguments": arguments,
                 "known": tool_name in tools, "override": tool_name in custom})
    return JSONResponse(sbe_stub.answer(tools, tool_name))
```

В `local/agent_lab_app.py` импорт:
```python
    from replay.recorder import ChainRecorder, Traces, forward_trace_id, record_idp, record_sbe
```
цикл с `_add_response_hook(client, sbe_hook(traces, trace_id))` заменить на:
```python
    for client in (APP_CTX.sbe_client, APP_CTX.sbe_tool_client):
        record_sbe(client, traces, trace_id, stubbed=False)
```
Функцию `_add_response_hook` удалить: она больше не используется.

- [ ] **Step 7: Тесты проходят, мок отвечает как раньше**

Run: `RT`
Expected: `OK`.

Run:
```bash
PYTHONPATH=local/stubs:src:. .venv/bin/python -c "
from fastapi.testclient import TestClient
from local.mocks import server
client = TestClient(server.app)
print(client.post(server.SBE_ENDPOINT, json={'name': 'organizationInfoByEpkId'}).json()['responseType'])
print(client.post(server.SBE_ENDPOINT, json={'name': 'nope'}).json()['text'])"
```
Expected:
```
JSON
{"code": 204, "message": "Нет данных"}
```

- [ ] **Step 8: Commit**

```bash
git add replay local/mocks/server.py local/agent_lab_app.py
git commit -m "Bank systems answer from the stand's fixtures inside the process (replay/sbe_stub.py), the mock uses the same answers; a bank-system call is recorded with its data"
```

---

### Task 5: Ответы из кэша IDP в трейсе

Агент берёт часть ответов из прогретого кэша IDP (`IdpCacheService.persist_to_local_cache`) и в IDP за ними не ходит.

**Files:**
- Modify: `replay/recorder.py` — `record_idp_cache`, `cache_call`
- Test: `replay/tests/test_recorder.py`

- [ ] **Step 1: Тесты**

```python
from types import SimpleNamespace

QUESTION = "Как вернуть терминал?"
CACHED = SimpleNamespace(idp_input=QUESTION, filter_value="*Эквайринг*",
                         idp_page_content="Терминал возвращают в отделение.",
                         idp_output="Верните терминал в отделение.")


def cache_service() -> type:
    """The agent's IdpCacheService as far as the recorder uses it: the warmed answers and the method that hands
    them to a request."""
    class FakeCacheService:
        def __init__(self, cache: dict) -> None:
            self._cache = cache

        def persist_to_local_cache(self, version: str) -> list:
            return []

    return FakeCacheService


class IdpCacheRecordingTest(unittest.TestCase):
    def setUp(self):
        self.traces = trace.Traces()
        self.current = ContextVar("trace", default=None)
        self.service = cache_service()
        queries = [SimpleNamespace(question=QUESTION, versions={"returns"})]
        trace.record_idp_cache(self.service, queries, self.traces, self.current.get)

    def test_a_cached_answer_is_a_knowledge_base_call_from_the_cache(self):
        self.current.set("t-1")
        self.service({QUESTION: CACHED}).persist_to_local_cache("returns")
        self.assertEqual(self.traces.get("t-1")["rag"], [{
            "seq": 1, "source": "cache", "status": "ok", "request": None, "query": QUESTION,
            "filter": "*Эквайринг*", "systemPrompt": "",
            "passages": [{"article": None, "passage": None, "text": "Терминал возвращают в отделение.",
                          "retrieval": None, "reranker": None}],
            "answer": "Верните терминал в отделение.", "reason": None, "seconds": 0.0}])

    def test_answers_cached_for_another_topic_are_left_out(self):
        self.current.set("t-2")
        self.service({QUESTION: CACHED}).persist_to_local_cache("tariffs")
        self.assertIsNone(self.traces.get("t-2"))
```

- [ ] **Step 2: Тесты падают**

Run: `RT`
Expected: FAIL — `AttributeError: … 'record_idp_cache'`.

- [ ] **Step 3: Реализация**

```python
def record_idp_cache(service: type, queries: list, traces: Traces, trace_id: TraceId) -> None:
    """The answers a request takes from the warmed IDP cache, as knowledge-base calls with source "cache": no IDP call
    is made for them. service is the agent's IdpCacheService, queries its SCHEDULED_IDP_QUERIES."""
    persist = service.persist_to_local_cache

    def persist_and_record(self, version):
        unsaved = persist(self, version)
        key = trace_id()
        if key:
            for entry in _cached_answers(self._cache, queries, version):
                traces.add(key, "rag", cache_call(entry))
        return unsaved

    service.persist_to_local_cache = persist_and_record


def cache_call(entry: Any) -> dict:
    """A cache entry (IdpCacheEntryDto) in the shape of a knowledge-base call: the cache keeps the document, not passages."""
    return {
        "source": "cache", "status": "ok", "request": None, "query": entry.idp_input, "filter": entry.filter_value,
        "systemPrompt": "",
        "passages": [{"article": None, "passage": None, "text": (entry.idp_page_content or "")[:MAX_TEXT],
                      "retrieval": None, "reranker": None}],
        "answer": (entry.idp_output or "")[:MAX_TEXT], "reason": None, "seconds": 0.0,
    }
```
Помощник:
```python
def _cached_answers(cache: dict, queries: list, version: Any) -> list:
    """The entries persist_to_local_cache hands to a request of this topic version."""
    entries = [cache.get(query.question) for query in queries if version in query.versions]
    return [entry for entry in entries if entry is not None and entry.idp_output]
```

- [ ] **Step 4: Тесты проходят**

Run: `RT`
Expected: `OK`.

- [ ] **Step 5: Commit**

```bash
git add replay
git commit -m "An answer the agent takes from the warmed IDP cache is recorded as a knowledge-base call from the cache"
```

---

### Task 6: Подключение записи одной функцией, база в памяти — в `replay/`

**Files:**
- Modify: `replay/recorder.py` — `record_agent`
- Move: `local/agent_lab_memory_db.py` → `replay/memory_db.py`, `local/test_agent_lab_memory_db.py` → `replay/tests/test_memory_db.py`
- Modify: `local/agent_lab_app.py`

- [ ] **Step 1: `record_agent`**

В `replay/recorder.py` после `record_idp_cache`:
```python
def record_agent(traces: Traces, *, sbe_stubbed: bool) -> None:
    """Record what every request does inside the agent: its chains, IDP calls and cached answers, SBE calls."""
    from aigw_service.context import APP_CTX
    from aigw_service.logger.aef_config import AEFConfig
    from aigw_service.service.idp.idp_cache_service import SCHEDULED_IDP_QUERIES, IdpCacheService

    # The middleware puts the request's x-trace-id here; asyncio tasks of the request copy it.
    trace_id = APP_CTX.context_vars_container.x_trace_id_var.get
    chains = ChainRecorder(traces, trace_id)
    # Read at every graph and chain call, so the bank's chains report here without being changed.
    AEFConfig.get_callbacks_config = lambda self: {"callbacks": [chains]}
    for client in (APP_CTX.idp_client, APP_CTX.sbe_client, APP_CTX.sbe_tool_client):
        forward_trace_id(client, trace_id)
    record_idp(APP_CTX.idp_client, traces, trace_id)
    for client in (APP_CTX.sbe_client, APP_CTX.sbe_tool_client):
        record_sbe(client, traces, trace_id, stubbed=sbe_stubbed)
    record_idp_cache(IdpCacheService, SCHEDULED_IDP_QUERIES, traces, trace_id)
```

- [ ] **Step 2: База в памяти**

```bash
git mv local/agent_lab_memory_db.py replay/memory_db.py
git mv local/test_agent_lab_memory_db.py replay/tests/test_memory_db.py
```
В `replay/tests/test_memory_db.py`:
```python
"""Run: PYTHONPATH=local/stubs:src:. .venv/bin/python -m unittest replay.tests.test_memory_db -v"""
```
```python
from replay import memory_db as memory
```
(вместо `from local import agent_lab_memory_db as memory`).

- [ ] **Step 3: `local/agent_lab_app.py`**

Функцию `main()` заменить целиком (всё выше неё — подмена MLS и `read_prompt` — не меняется):
```python
def main():
    from fastapi import HTTPException

    from aigw_service.__main__ import main as serve, app_main
    from aigw_service.context import APP_CTX
    # Import now: these module constants are used by the agent itself.
    from aigw_service.agent.prompt import prompts  # noqa: F401
    from replay.recorder import Traces, record_agent

    # The agent's settings have loaded .env into the environment by now.
    without_database = os.environ.get('AGENT_LAB_NO_DB', '').strip().lower() in ('1', 'true', 'yes')
    if without_database:
        from replay.memory_db import install
        install()

    version = subprocess.check_output(['git', 'rev-parse', '--short', 'HEAD'], cwd=ROOT, text=True).strip()
    identity = {'instanceId': INSTANCE, 'pid': os.getpid(), 'version': version,
                'mlsEnabled': APP_CTX.mls_client_enabled, 'loadedPrompts': dict(LOADED),
                'database': 'memory' if without_database else 'postgres'}

    traces = Traces()
    record_agent(traces, sbe_stubbed=False)

    @app_main.get('/local/agent-lab/identity')
    async def agent_lab_identity():
        return identity

    @app_main.get('/local/agent-lab/trace/{trace_id}')
    async def agent_lab_trace(trace_id: str):
        found = traces.get(trace_id)
        if found is None:
            raise HTTPException(404, 'trace not found')
        return found

    serve()
```

- [ ] **Step 4: Проверка**

Run: `RT`
Expected: `OK`.

Run: `PYTHONPATH=local/stubs:src .venv/bin/python -m unittest local.test_agent_lab_target -v`
Expected: `OK`.

Run:
```bash
PYTHONPATH=local/stubs:src:. .venv/bin/python -c "
from replay.recorder import Traces, record_agent
record_agent(Traces(), sbe_stubbed=False)
print('ok')"
```
Expected: последняя строка `ok`.

- [ ] **Step 5: Commit**

```bash
git add replay local
git commit -m "record_agent wires the whole recording in one call for the local app and the replay service; the memory database moves to replay/"
```

---

### Task 7: `src/` и `local_env` — чистый снимок агента

**Files:** Revert `src/`, `local_env` → `2bf2e31`.

- [ ] **Step 1: Откат**

```bash
git restore --source=2bf2e31 --staged --worktree -- src/ local_env
```

- [ ] **Step 2: Снимок совпадает**

Run: `git diff --stat 2bf2e31 -- src/ local_env`
Expected: пусто.

Run: `git diff --cached --stat | tail -1`
Expected: `12 files changed`: 11 в `src/` из коммитов 123bd6f, 4309fc0, 2bad6b2, f819340 и `local_env`. Файла `src/aigw_service/service/idp/idp_own_generation.py` больше нет.

- [ ] **Step 3: Обвязка не зависела от отката**

Run: `RT`
Expected: `OK`.

Run: `PYTHONPATH=local/stubs:src .venv/bin/python -m unittest local.test_agent_lab_target -v`
Expected: `OK`.

- [ ] **Step 4: Commit**

```bash
git commit -m "src/ and local_env are the pristine agent again (2bf2e31): no own IDP generation, no x-trace-id hook in context.py — the replay must behave as production"
```

---

### Task 8: Промпты из MLS и готовность сервиса

**Files:**
- Create: `replay/prompts.py`, `replay/readiness.py`
- Test: `replay/tests/test_prompts.py`, `replay/tests/test_readiness.py`

- [ ] **Step 1: Тесты промптов**

`replay/tests/test_prompts.py`:
```python
"""Run: PYTHONPATH=local/stubs:src:. .venv/bin/python -m unittest replay.tests.test_prompts -v"""
import unittest
from types import SimpleNamespace

from replay import prompts

PROMPT = [{"role": "system", "content": "Ты помощник по эквайрингу."}]


class RecordLoadedTest(unittest.TestCase):
    def setUp(self):
        prompts.LOADED.clear()
        self.mls = SimpleNamespace(_read_prompt_file=lambda filename, app_ctx: PROMPT)
        prompts.record_loaded(self.mls)

    def test_the_prompt_is_read_as_before(self):
        self.assertEqual(self.mls._read_prompt_file("agent_doc_type_prompt.json", None), PROMPT)

    def test_a_read_prompt_is_named_with_its_digest(self):
        self.mls._read_prompt_file("agent_doc_type_prompt.json", None)
        self.assertEqual(prompts.LOADED, {"agent_doc_type_prompt.json": prompts.digest(PROMPT)})


class DigestTest(unittest.TestCase):
    def test_key_order_does_not_change_the_digest(self):
        self.assertEqual(prompts.digest({"a": 1, "b": 2}), prompts.digest({"b": 2, "a": 1}))


class CodePromptsTest(unittest.TestCase):
    def test_code_prompts_are_refused_by_default(self):
        self.assertFalse(prompts.code_prompts_allowed({}))

    def test_code_prompts_are_allowed_by_name(self):
        self.assertTrue(prompts.code_prompts_allowed({prompts.ALLOW_CODE_PROMPTS: "True"}))
```

- [ ] **Step 2: Тесты готовности**

`replay/tests/test_readiness.py`:
```python
"""Run: PYTHONPATH=local/stubs:src:. .venv/bin/python -m unittest replay.tests.test_readiness -v"""
import unittest
from types import SimpleNamespace

from replay import readiness

MLS = readiness.Prompts(mls_enabled=True, version="0.0.1", loaded={"agent_doc_type_prompt.json": "h"},
                        code_allowed=False)
WARM = readiness.Warmup(total=2, warmed=2, done=True)
SWITCHES = ["db:memory", "sbe:stub"]


def health(prompts=MLS, warmup=WARM) -> dict:
    return readiness.health(prompts, warmup, SWITCHES)


class HealthTest(unittest.TestCase):
    def test_ready_with_mls_prompts_and_a_warm_cache(self):
        self.assertEqual((health()["ready"], health()["problems"]), (True, []))

    def test_names_the_prompts_version_and_their_digests(self):
        self.assertEqual(health()["prompts"], {"version": "0.0.1", "hashes": {"agent_doc_type_prompt.json": "h"}})

    def test_lists_the_switches(self):
        self.assertEqual(health()["isolation"], SWITCHES)

    def test_not_ready_while_the_cache_warms(self):
        self.assertEqual(health(warmup=readiness.Warmup(total=2))["problems"], [readiness.WARMING])

    def test_prompts_from_the_agents_code_are_a_problem(self):
        code = readiness.Prompts(mls_enabled=False, version="0.0.1", loaded={}, code_allowed=False)
        self.assertEqual(health(prompts=code)["problems"], [readiness.PROMPTS_FROM_CODE])

    def test_prompts_from_code_allowed_by_name_are_named_so(self):
        code = readiness.Prompts(mls_enabled=False, version="0.0.1", loaded={}, code_allowed=True)
        self.assertEqual((health(prompts=code)["ready"], health(prompts=code)["prompts"]["version"]),
                         (True, readiness.CODE_PROMPTS))

    def test_mls_without_a_version_is_a_problem(self):
        unnamed = readiness.Prompts(mls_enabled=True, version="", loaded={}, code_allowed=False)
        self.assertEqual(health(prompts=unnamed)["problems"], [readiness.NO_VERSION])

    def test_mls_without_a_read_prompt_is_a_problem(self):
        empty = readiness.Prompts(mls_enabled=True, version="0.0.1", loaded={}, code_allowed=False)
        self.assertEqual(health(prompts=empty)["problems"], [readiness.NO_PROMPTS])


QUERIES = [SimpleNamespace(question="Как вернуть терминал?", input_name="return"),
           SimpleNamespace(question="Какой тариф?", input_name="tariff")]


class FakeCache:
    def __init__(self, answered: set[str]) -> None:
        self._cache = {question: object() for question in answered}


class WarmTest(unittest.IsolatedAsyncioTestCase):
    async def warm(self, create) -> tuple[readiness.Warmup, list]:
        warmup, installed = readiness.Warmup(total=len(QUERIES)), []
        await readiness.warm(create, QUERIES, warmup, installed.append)
        return warmup, installed

    async def test_counts_the_questions_that_got_an_answer(self):
        async def create():
            return FakeCache({"Как вернуть терминал?"})

        warmup, installed = await self.warm(create)
        self.assertEqual((warmup.warmed, warmup.failed, warmup.done, len(installed)), (1, ["tariff"], True, 1))

    async def test_a_failed_warm_up_marks_it_done(self):
        async def create():
            raise RuntimeError("IDP недоступен")

        warmup = readiness.Warmup(total=len(QUERIES))
        with self.assertRaises(RuntimeError):
            await readiness.warm(create, QUERIES, warmup, lambda cache: None)
        self.assertTrue(warmup.done)
```

- [ ] **Step 3: Тесты падают**

Run: `RT`
Expected: FAIL — `ImportError: cannot import name 'prompts' from 'replay'`.

- [ ] **Step 4: `replay/prompts.py`**

```python
"""System prompts this instance read from ML Storage (MLS): file name → sha256 of the content. The replay service
names them in /health and is not ready without them: with MLS off the agent silently takes the prompts written in
its code (src/aigw_service/agent/prompt/prompts.py)."""
import hashlib
import json
import os
from collections.abc import Mapping
from typing import Any

LOADED: dict[str, str] = {}
# Only for a laptop run against local/mocks, where there is no MLS: the agent's code prompts are then taken on
# purpose and /health names them so (readiness.CODE_PROMPTS).
ALLOW_CODE_PROMPTS = "REPLAY_ALLOW_CODE_PROMPTS"


def record_loaded(mls: Any) -> None:
    """mls is aigw_service.ml_storage.mls_client_service. Call before the agent's prompts module is imported: it reads
    the MLS files once, at import, through the module's _read_prompt_file."""
    read = mls._read_prompt_file

    def read_and_record(filename: str, app_ctx: Any) -> list | dict:
        data = read(filename, app_ctx)
        LOADED[filename] = digest(data)
        return data

    mls._read_prompt_file = read_and_record


def digest(data: object) -> str:
    return hashlib.sha256(json.dumps(data, ensure_ascii=False, sort_keys=True).encode()).hexdigest()


def code_prompts_allowed(environ: Mapping[str, str] = os.environ) -> bool:
    return environ.get(ALLOW_CODE_PROMPTS, "").strip().lower() in ("1", "true", "yes")
```

- [ ] **Step 5: `replay/readiness.py`**

```python
"""Whether the replay service replays the agent as production runs it: prompts from ML Storage and the IDP cache
warmed. GET /health answers with health(); the problems are words the Lab shows."""
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

CODE_PROMPTS = "код агента"
PROMPTS_FROM_CODE = ("Промпты взяты из кода агента, а не из ML Storage. Чтобы повторять агента как в проде, "
                     "включите MLS_CLIENT_ENABLED.")
NO_VERSION = "Не задана версия промптов в ML Storage (MLS_CLIENT_PROMPTS_VERSION)."
NO_PROMPTS = "Агент не прочитал ни одного промпта из ML Storage."
WARMING = "Кэш базы знаний ещё прогревается."


@dataclass(frozen=True)
class Prompts:
    mls_enabled: bool
    version: str
    loaded: dict[str, str]
    code_allowed: bool


@dataclass
class Warmup:
    """The IDP cache warm-up at start: how many of the agent's fixed questions got an answer."""
    total: int
    warmed: int = 0
    failed: list[str] = field(default_factory=list)
    done: bool = False


def health(prompts: Prompts, warmup: Warmup, isolation: list[str]) -> dict:
    problems = [*_prompt_problems(prompts), *([] if warmup.done else [WARMING])]
    return {
        "ready": not problems,
        "prompts": {"version": prompts.version if prompts.mls_enabled else CODE_PROMPTS,
                    "hashes": dict(prompts.loaded)},
        "idpCache": {"total": warmup.total, "warmed": warmup.warmed, "failed": list(warmup.failed)},
        "isolation": list(isolation),
        "problems": problems,
    }


async def warm(create: Callable[[], Awaitable[Any]], queries: list, warmup: Warmup,
               install: Callable[[Any], None]) -> None:
    """Warm the agent's IDP cache as its own start does in production (IdpCacheService.create) and hand it to the
    agent (APP_CTX.set_idp_cache); the service is not ready until this ends."""
    try:
        cache = await create()
        install(cache)
        warmup.warmed = sum(1 for query in queries if query.question in cache._cache)
        warmup.failed = [query.input_name for query in queries if query.question not in cache._cache]
    finally:
        warmup.done = True


def _prompt_problems(prompts: Prompts) -> list[str]:
    if not prompts.mls_enabled:
        return [] if prompts.code_allowed else [PROMPTS_FROM_CODE]
    if not prompts.version:
        return [NO_VERSION]
    return [] if prompts.loaded else [NO_PROMPTS]
```

- [ ] **Step 6: Тесты проходят**

Run: `RT`
Expected: `OK`.

- [ ] **Step 7: Commit**

```bash
git add replay
git commit -m "The replay service is ready only with prompts read from ML Storage and the IDP cache warmed, and says why not in words"
```

---

### Task 9: Выключатели побочных эффектов

**Files:**
- Create: `replay/isolation.py`
- Test: `replay/tests/test_isolation.py`

- [ ] **Step 1: Тесты**

`replay/tests/test_isolation.py`:
```python
"""Run: PYTHONPATH=local/stubs:src:. .venv/bin/python -m unittest replay.tests.test_isolation -v"""
import unittest
from types import SimpleNamespace

import httpx

from replay import isolation

TOOLS = {"getLkkTariff": {"responseType": "JSON", "text": {"tariff": "2%"}}}


def app_ctx() -> SimpleNamespace:
    """The parts of the agent's APP_CTX the switches touch. A proxy from the environment is mounted on the client:
    httpx would send a call through it past the client's own transport."""
    proxied = httpx.AsyncClient(base_url="https://sbe.bank", mounts={"all://": httpx.AsyncHTTPTransport()})
    return SimpleNamespace(sbe_client=proxied, sbe_tool_client=httpx.AsyncClient(base_url="https://sbe.bank"),
                           elastic_search=None, excel_logs=True)


class ApplyTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.ctx = app_ctx()
        self.switched = isolation.apply(self.ctx, TOOLS)

    def test_names_every_switch(self):
        self.assertEqual(self.switched, ["db:memory", "sbe:stub", "elastic:off", "excel:off", "scheduler:off"])

    async def test_bank_systems_answer_in_process_even_behind_a_proxy(self):
        response = await self.ctx.sbe_client.post("/execute", json={"name": "getLkkTariff"})
        self.assertEqual(response.json()["toolName"], "getLkkTariff")

    async def test_logs_for_elastic_go_nowhere(self):
        self.assertIsNone(await self.ctx.elastic_search.send_index({}, request_id="t"))

    def test_excel_log_is_off(self):
        self.assertFalse(self.ctx.excel_logs)


class EnvironmentTest(unittest.TestCase):
    def test_aef_is_off_and_the_idp_cache_on_before_the_agent_reads_its_flags(self):
        environ: dict[str, str] = {}
        self.assertEqual(isolation.configure_environment(environ), ["aef:off"])
        self.assertEqual(environ, {"AEF_ENABLED": "False", "IDP_CACHE_ENABLED": "True"})


class IdpCacheTest(unittest.TestCase):
    def test_the_cache_warms_in_local_mode(self):
        module = SimpleNamespace(local=True)
        isolation.allow_idp_cache(module)
        self.assertFalse(module.local)
```

- [ ] **Step 2: Тесты падают**

Run: `RT`
Expected: FAIL — `ImportError: cannot import name 'isolation' from 'replay'`.

- [ ] **Step 3: Реализация**

`replay/isolation.py`:
```python
"""What the replay service switches off so a replay writes nothing outside its process and does only what an answer
needs. configure_environment() runs before the agent's code is imported, apply() right after it; both return the
names GET /health lists."""
import os
from collections.abc import MutableMapping
from typing import Any

import httpx

from replay import sbe_stub

# The agent reads these once, when its config module is imported.
ENVIRONMENT = {"AEF_ENABLED": "False", "IDP_CACHE_ENABLED": "True"}


class SilentElastic:
    """Stands in for the agent's Elastic log sender (APP_CTX.elastic_search): no log goes to the bank's Elastic."""

    async def send_index(self, *args: Any, **kwargs: Any) -> None:
        return None

    async def disconnect(self) -> None:
        return None


def configure_environment(environ: MutableMapping[str, str] = os.environ) -> list[str]:
    environ.update(ENVIRONMENT)
    return ["aef:off"]


def apply(app_ctx: Any, sbe_tools: dict) -> list[str]:
    return [
        keep_database_in_memory(),
        answer_bank_systems_from_fixtures(app_ctx, sbe_tools),
        silence_elastic(app_ctx),
        turn_off_excel_log(app_ctx),
        # replay/app.py never starts the agent's lifespan, which runs its scheduler.
        "scheduler:off",
    ]


def keep_database_in_memory() -> str:
    # Imported here: memory_db loads the agent's modules, which must wait for configure_environment().
    from replay import memory_db

    memory_db.install()
    return "db:memory"


def answer_bank_systems_from_fixtures(app_ctx: Any, tools: dict) -> str:
    for client in (app_ctx.sbe_client, app_ctx.sbe_tool_client):
        _replace_transport(client, sbe_stub.transport(tools))
    return "sbe:stub"


def silence_elastic(app_ctx: Any) -> str:
    app_ctx.elastic_search = SilentElastic()
    return "elastic:off"


def turn_off_excel_log(app_ctx: Any) -> str:
    app_ctx.excel_logs = False
    return "excel:off"


def allow_idp_cache(idp_cache_module: Any) -> None:
    """The agent warms its IDP cache only outside LOCAL mode, and the stand needs LOCAL=True for client certificates.
    Not a switch off: production has the cache, so the replay has it too."""
    idp_cache_module.local = False


def _replace_transport(client: httpx.AsyncClient, transport: httpx.AsyncBaseTransport) -> None:
    # Modules bound the client at import, so it is changed in place. A proxy from the environment is a mount that
    # would carry calls past the client's own transport: mounts go too.
    client._transport = transport
    client._mounts = {}
```

- [ ] **Step 4: Тесты проходят**

Run: `RT`
Expected: `OK`.

- [ ] **Step 5: Commit**

```bash
git add replay
git commit -m "replay/isolation.py: the database in memory, bank systems from fixtures even behind a proxy, no Elastic, no Excel log, no AEF, no scheduler"
```

---

### Task 10: HTTP API сервиса

**Files:**
- Create: `replay/api.py`
- Test: `replay/tests/test_api.py`

- [ ] **Step 1: Тесты**

`replay/tests/test_api.py`:
```python
"""Run: PYTHONPATH=local/stubs:src:. .venv/bin/python -m unittest replay.tests.test_api -v"""
import unittest

import httpx
from fastapi import FastAPI, Request

from replay import api
from replay.recorder import Traces


def fake_agent(traces: Traces) -> FastAPI:
    """Answers like the agent and records into the trace of the request's x-trace-id, as the real one does."""
    agent = FastAPI()

    @agent.post(api.AGENT_PATH)
    async def answer(request: Request) -> dict:
        traces.add(request.headers["x-trace-id"], "rag", {"source": "idp", "query": "как вернуть терминал"})
        body = await request.json()
        said = body["message"]["content"]["user_input"]
        return {"message": {"content": {"status_code": "200", "result": f"ответ на {said}"}},
                "headers": {key: request.headers.get(key) for key in ("x-client-id", "x-session-id")}}

    return agent


def turn(text: str = "привет") -> dict:
    return {"message": {"conversation_id": "c-1", "content": {"user_input": text}}}


class ReplayTurnTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.traces = Traces()
        self.state = {"ready": True, "problems": []}
        app = api.create_app(fake_agent(self.traces), self.traces, lambda: self.state)
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://replay")

    async def asyncTearDown(self):
        await self.client.aclose()

    async def test_answers_with_the_agents_reply(self):
        answer = (await self.client.post("/replay/turn", json=turn())).json()
        self.assertEqual((answer["agent"]["status"], answer["agent"]["body"]["message"]["content"]["result"]),
                         (200, "ответ на привет"))

    async def test_answers_with_the_trace_of_this_turn(self):
        answer = (await self.client.post("/replay/turn", json=turn())).json()
        self.assertEqual(answer["trace"]["rag"][0]["query"], "как вернуть терминал")

    async def test_a_trace_is_given_once(self):
        await self.client.post("/replay/turn", json=turn())
        self.assertEqual(len(self.traces), 0)

    async def test_the_agent_gets_the_protocol_headers(self):
        answer = (await self.client.post("/replay/turn", json=turn())).json()
        self.assertEqual(answer["agent"]["body"]["headers"], {"x-client-id": api.CLIENT_ID, "x-session-id": "c-1"})

    async def test_a_service_not_ready_refuses_with_its_problems(self):
        self.state = {"ready": False, "problems": ["Кэш базы знаний ещё прогревается."]}
        response = await self.client.post("/replay/turn", json=turn())
        self.assertEqual((response.status_code, response.json()["problems"]),
                         (503, ["Кэш базы знаний ещё прогревается."]))

    async def test_a_body_that_is_not_an_object_is_refused(self):
        self.assertEqual((await self.client.post("/replay/turn", json=[])).status_code, 400)

    async def test_health_is_the_services_state(self):
        self.assertEqual((await self.client.get("/health")).json(), self.state)
```

- [ ] **Step 2: Тесты падают**

Run: `RT`
Expected: FAIL — `ImportError: cannot import name 'api' from 'replay'`.

- [ ] **Step 3: Реализация**

`replay/api.py`:
```python
"""HTTP API of the replay service: POST /replay/turn — one customer message of a recorded conversation through the
agent, with what happened inside it; GET /health — whether the service replays the agent as production runs it."""
import asyncio
import contextlib
import time
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable
from datetime import datetime, timezone

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from starlette.types import ASGIApp

from replay.recorder import Traces

AGENT_PATH = "/api/v1/ai/agents/agent-ckr-pa-acquiring"
CLIENT_ID = "agent-lab-replay"
NOT_AN_OBJECT = "Тело запроса — не JSON-объект с запросом агента."

Health = Callable[[], dict]
Start = Callable[[], Awaitable[None]]


def create_app(agent: ASGIApp, traces: Traces, health: Health, start: Start | None = None) -> FastAPI:
    """agent is the agent's own app (aigw_service.api.app_main), called in this process; its lifespan (Postgres,
    scheduler, Elastic) never runs. start runs in the background once the service is up (the IDP cache warm-up)."""
    # The agent's error answers are its replies: raise_app_exceptions=False keeps a 500 a response, not an exception.
    client = httpx.AsyncClient(transport=httpx.ASGITransport(app=agent, raise_app_exceptions=False),
                               base_url="http://agent", timeout=None)

    @contextlib.asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        task = asyncio.create_task(start()) if start else None
        yield
        if task:
            task.cancel()
        await client.aclose()

    app = FastAPI(title="Acquiring agent replay", lifespan=lifespan)

    @app.get("/health")
    async def get_health() -> dict:
        return health()

    @app.post("/replay/turn")
    async def replay_turn(request: Request) -> JSONResponse:
        state = health()
        if not state["ready"]:
            return JSONResponse({"problems": state["problems"]}, status_code=503)
        body = await _object(request)
        if body is None:
            return JSONResponse({"problems": [NOT_AN_OBJECT]}, status_code=400)
        return JSONResponse(await _turn(client, traces, body))

    return app


async def _turn(client: httpx.AsyncClient, traces: Traces, body: dict) -> dict:
    trace_id = str(uuid.uuid4())
    started = time.monotonic()
    response = await client.post(AGENT_PATH, json=body, headers=_headers(trace_id, body))
    return {
        "agent": {"status": response.status_code, "body": _content(response)},
        "seconds": round(time.monotonic() - started, 2),
        "trace": traces.take(trace_id),
    }


def _headers(trace_id: str, body: dict) -> dict:
    """The protocol 1.5 headers the agent requires; without x-session-id its middleware answers 500 (LOCAL.md)."""
    conversation_id = str((body.get("message") or {}).get("conversation_id") or trace_id)
    return {
        "x-trace-id": trace_id,
        "x-client-id": CLIENT_ID,
        "x-session-id": conversation_id,
        "x-request-time": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }


async def _object(request: Request) -> dict | None:
    try:
        value = await request.json()
    except ValueError:
        return None
    return value if isinstance(value, dict) else None


def _content(response: httpx.Response) -> object:
    try:
        return response.json()
    except ValueError:
        return response.text
```

- [ ] **Step 4: Тесты проходят**

Run: `RT`
Expected: `OK`.

- [ ] **Step 5: Commit**

```bash
git add replay
git commit -m "replay/api.py: POST /replay/turn answers with the agent's reply and the turn's trace, GET /health with the service's state"
```

---

### Task 11: Точка входа, запуск на ноутбуке, конфигурация стенда

**Files:**
- Create: `replay/app.py`, `replay/run.sh`, `replay/replay.env.example`

- [ ] **Step 1: `replay/app.py`**

```python
"""The replay service: python -m replay.app from the agent's repository root (replay/run.sh) or in its image
(Dockerfile.replay). The order matters: the agent reads its flags and its MLS prompts once, while its modules are
imported."""
import os

from replay import isolation


def main() -> None:
    switched = isolation.configure_environment()

    from aigw_service.ml_storage import mls_client_service

    from replay import prompts

    prompts.record_loaded(mls_client_service)

    import uvicorn
    from aigw_service.agent.prompt import prompts as agent_prompts  # noqa: F401 - reads the MLS prompts now
    from aigw_service.api import app_main
    from aigw_service.context import APP_CTX
    from aigw_service.service.idp import idp_cache_service

    from replay import readiness, recorder, sbe_stub
    from replay.api import create_app

    switched += isolation.apply(APP_CTX, sbe_stub.load())
    isolation.allow_idp_cache(idp_cache_service)
    traces = recorder.Traces()
    recorder.record_agent(traces, sbe_stubbed=True)

    loaded = readiness.Prompts(mls_enabled=APP_CTX.mls_client_enabled, version=APP_CTX.mls_client_prompts_version,
                               loaded=prompts.LOADED, code_allowed=prompts.code_prompts_allowed())
    queries = idp_cache_service.SCHEDULED_IDP_QUERIES
    warmup = readiness.Warmup(total=len(queries))

    async def warm() -> None:
        await readiness.warm(idp_cache_service.IdpCacheService.create, queries, warmup, APP_CTX.set_idp_cache)

    app = create_app(app_main, traces, lambda: readiness.health(loaded, warmup, switched), start=warm)
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("REPLAY_PORT", "8080")))


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: `replay/run.sh`**

```bash
#!/usr/bin/env bash
# Сервис повтора на этом компьютере: python -m replay.app с .env агента.
# С local/env.local GigaChat, IDP и SBE — заглушки: сначала ./local/run-mocks.sh. ML Storage там нет, поэтому
# запускайте с REPLAY_ALLOW_CODE_PROMPTS=True: промпты возьмутся из кода агента, и /health так и скажет.
# Порт — REPLAY_PORT, по умолчанию 8082: на 8080 работает агент для target local-http.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

[ -e .env ] || { echo "нет .env: сделайте ссылку на local/env.local или соберите его по replay/replay.env.example" >&2; exit 1; }

# local/stubs — aef_tracing и mls_client_lib, которых нет вне контура банка. В образе стоят настоящие.
export PYTHONPATH="$ROOT/local/stubs:$ROOT/src:$ROOT${PYTHONPATH:+:$PYTHONPATH}"
export REPLAY_PORT="${REPLAY_PORT:-8082}"

exec .venv/bin/python -m replay.app
```
```bash
chmod +x replay/run.sh
```

- [ ] **Step 3: `replay/replay.env.example`**

```
# Сервис повтора агента эквайринга: значения поверх local_env. Последнее значение ключа в .env побеждает.
#   cp local_env .env && cat replay/replay.env.example >> .env
# Логины и пароли — из секретов стенда. Сертификаты монтируются файлами по путям ниже.
LOCAL=True
MLS_CLIENT_ENABLED=True
# Как в local_env. Подтвердить у команды эквайринга, что это версия прода.
MLS_CLIENT_PROMPTS_VERSION="0.0.1"
MLS_CLIENT_CERT_PATH=/certs/mls/ca.pem
IDP_CACHE_ENABLED=True
EXCEL_LOGS=False
AEF_ENABLED=False
GIGACHAT_TLS_CERT_FILEPATH=/certs/gigachat/cert.pem
GIGACHAT_KEY_FILEPATH=/certs/gigachat/private.key
GIGACHAT_CA_BUNDLE_FILEPATH=/certs/idp/ca.pem
TLS_CERT_FILEPATH=/certs/idp/certificate.pem
KEY_FILEPATH=/certs/idp/private_key.key
REPLAY_PORT=8080
```

- [ ] **Step 4: Сервис поднимается на заглушках**

В одном терминале: `./local/run-mocks.sh`
В другом: `REPLAY_ALLOW_CODE_PROMPTS=True ./replay/run.sh`

Run (через 10–30 с): `curl -s http://127.0.0.1:8082/health`
Expected: JSON с `"isolation": ["aef:off", "db:memory", "sbe:stub", "elastic:off", "excel:off", "scheduler:off"]`,
`"prompts": {"version": "код агента", …}` и, после прогрева, `"ready": true`. Если прогрев упал на `KeyError`
(`business_channel_enrichment`, см. `LOCAL.md`), `idpCache.failed` перечисляет вопросы, а `ready` всё равно `true`.

- [ ] **Step 5: Commit**

```bash
git add replay
git commit -m "replay/app.py starts the replay service in the order the agent reads its flags and prompts; replay/run.sh for a laptop, replay.env.example for the stand"
```

---

### Task 12: Проверка запущенного сервиса на заглушках

**Files:**
- Create: `replay/tests/test_against_mocks.py`

- [ ] **Step 1: Тест**

```python
"""The running replay service against the stand's mocks: no bank system is called, a turn comes with its trace.
Skipped unless both run:
  ./local/run-mocks.sh
  REPLAY_ALLOW_CODE_PROMPTS=True ./replay/run.sh
  REPLAY_TEST_URL=http://127.0.0.1:8082 REPLAY_TEST_MOCKS_URL=http://127.0.0.1:8090 \\
    PYTHONPATH=local/stubs:src:. .venv/bin/python -m unittest replay.tests.test_against_mocks -v"""
import os
import time
import unittest
import uuid

import httpx

SERVICE = os.environ.get("REPLAY_TEST_URL", "")
MOCKS = os.environ.get("REPLAY_TEST_MOCKS_URL", "")
READY_WITHIN = 300
SWITCHES = {"db:memory", "sbe:stub", "elastic:off", "excel:off", "aef:off", "scheduler:off"}


def turn(text: str) -> dict:
    """A one-message conversation as the bank chat sends it (Lab: lab/agents/http.py local_request)."""
    conversation_id = str(uuid.uuid4())
    return {
        "message": {
            "version": "1.4", "performative": "request", "sender": "GIGAASSISTANT", "receiver": "agent",
            "conversation_id": conversation_id, "reply_with": str(uuid.uuid4()),
            "content": {"user_input": text, "trigger_phrase_id": "1", "phrases": [
                {"phrase_id": "1", "speaker_type": "CUSTOMER", "text": text, "time": "2026-01-01T00:00:01+00:00"}]},
        },
        "metadata": {"surface_mode": "CHAT", "communication_channel": "TEXT",
                     "organization": {"epk_id": "1000000001"},
                     "customer_info": {"authorized": True, "digital_user_id": conversation_id[:8]},
                     "dialog": {"dialog_id": conversation_id}},
    }


def wait_ready() -> dict:
    deadline = time.monotonic() + READY_WITHIN
    while True:
        health = httpx.get(f"{SERVICE}/health", timeout=5).json()
        if health["ready"] or time.monotonic() > deadline:
            return health
        time.sleep(2)


def mock_calls(**params) -> dict:
    return httpx.get(f"{MOCKS}/mock/calls", params=params, timeout=5).json()


@unittest.skipUnless(SERVICE and MOCKS, "нужны запущенные local/run-mocks.sh и replay/run.sh")
class AgainstMocksTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.health = wait_ready()
        cursor = mock_calls(limit=0)["cursor"]
        answer = httpx.post(f"{SERVICE}/replay/turn", json=turn("Терминал заблокирован, что делать?"), timeout=300)
        cls.answer = answer.json()
        cls.calls = mock_calls(after=cursor, limit=500)["calls"]

    def test_the_service_is_ready(self):
        self.assertTrue(self.health["ready"], self.health["problems"])

    def test_health_lists_every_switch(self):
        self.assertEqual(set(self.health["isolation"]), SWITCHES)

    def test_no_bank_system_is_called(self):
        self.assertEqual([call for call in self.calls if call.get("kind") == "sbe"], [])

    def test_the_agent_answers(self):
        self.assertIn("message", self.answer["agent"]["body"])

    def test_the_turn_comes_with_its_model_calls(self):
        self.assertTrue(self.answer["trace"]["chains"])

    def test_events_are_numbered_without_gaps(self):
        trace = self.answer["trace"]
        numbers = sorted(event["seq"] for kind in ("chains", "rag", "systems") for event in trace[kind])
        self.assertEqual(numbers, list(range(1, len(numbers) + 1)))
```

- [ ] **Step 2: Без запущенных сервисов тест пропускается**

Run: `RT`
Expected: `OK (skipped=1)`.

- [ ] **Step 3: С запущенными сервисами проходит**

Запустить заглушки и сервис, как в Task 11 Step 4. Затем:

Run: `REPLAY_TEST_URL=http://127.0.0.1:8082 REPLAY_TEST_MOCKS_URL=http://127.0.0.1:8090 PYTHONPATH=local/stubs:src:. .venv/bin/python -m unittest replay.tests.test_against_mocks -v`
Expected: `OK`, 6 тестов. Если `test_no_bank_system_is_called` падает, это значит, что запрос в SBE ушёл в сеть.
Смотреть `isolation.answer_bank_systems_from_fixtures`.

- [ ] **Step 4: Commit**

```bash
git add replay/tests/test_against_mocks.py
git commit -m "The running replay service is checked against the stand's mocks: no bank system called, the turn comes with its numbered trace"
```

---

### Task 13: Образ и документация

**Files:**
- Create: `Dockerfile.replay`
- Modify: `LOCAL.md`

- [ ] **Step 1: `Dockerfile.replay`**

```dockerfile
# Сервис повтора агента эквайринга для Agent Lab (раздел «Сервис повтора» в LOCAL.md).
# Сборка в два шага: зависимости агента и банковские пакеты (mls_client_lib, aef_tracing) ставит его Dockerfile.
#   docker build --target builder -t aigw-acquiring-builder \
#     --build-arg DOCKER_BASE_IMAGE=… --build-arg NEXUS3USER=… --build-arg NEXUS3PASS=… --build-arg OSCTOKENAUTH=… .
#   docker build -f Dockerfile.replay -t aigw-acquiring-replay .
ARG BUILDER_IMAGE=aigw-acquiring-builder
FROM ${BUILDER_IMAGE}

WORKDIR /opt/app-root
COPY replay/ ./replay/
COPY local/mocks/fixtures/sbe.json ./local/mocks/fixtures/sbe.json
RUN mkdir -p /tmp/mls_cache && chmod 777 /tmp/mls_cache

ENV PYTHONUNBUFFERED=1 \
    PYTHONIOENCODING=UTF-8 \
    REPLAY_PORT=8080
EXPOSE 8080
CMD ["/opt/app-root/.venv/bin/python", "-m", "replay.app"]
```
Собрать образ на ноутбуке нельзя: нужен Nexus банка. Проверка сборки — на рабочем компьютере, в Task 13 не требуется.

- [ ] **Step 2: Раздел в `LOCAL.md`**

В конец `LOCAL.md`:
```markdown
## Сервис повтора для Agent Lab

`replay/` — агент как сервис повтора разговоров: `POST /replay/turn` принимает родной запрос агента и отвечает его
ответом и трейсом шага, `GET /health` говорит, готов ли сервис. Во внешние системы он не пишет: база в памяти, SBE
отвечает из `local/mocks/fixtures/sbe.json`, Elastic, Excel-лог, AEF и scheduler выключены. Промпты — из ML Storage,
кэш IDP прогревается на старте, как в проде. Спека — в conductor-playground,
`docs/superpowers/specs/2026-10-06-acquiring-replay-service-design.md`.

На ноутбуке с заглушками:

    ./local/run-mocks.sh
    REPLAY_ALLOW_CODE_PROMPTS=True ./replay/run.sh        # порт 8082
    curl -s http://127.0.0.1:8082/health

На стенде: образ `Dockerfile.replay`, `.env` — `local_env` плюс `replay/replay.env.example`. Одна реплика, готовность
по `GET /health` → `ready: true`, доступ наружу только к GigaChat, IDP и ML Storage.

Тесты: `PYTHONPATH=local/stubs:src:. .venv/bin/python -m unittest discover -s replay/tests -t . -v`.
```

- [ ] **Step 3: Commit**

```bash
git add Dockerfile.replay LOCAL.md
git commit -m "Dockerfile.replay builds the replay service on the agent's builder image; LOCAL.md says how to run it"
```

- [ ] **Step 4: Ветка в origin**

Спросить пользователя, пушить ли `feat/replay-service`. Если да: `git push -u origin feat/replay-service`.

---

## Часть B. Lab (conductor-playground)

### Task 14: Критерий «совпадение с продом»

**Files:**
- Create: `backend/lab/match.py`, `backend/tests/test_match.py`
- Modify: `backend/lab/judge.py` (`step_verdict`), `backend/lab/replay.py` (`criteria_by_dialogue`, `_judge_step`)
- Test: `backend/tests/test_replay.py`

- [ ] **Step 1: Тесты модуля**

`backend/tests/test_match.py`:
```python
import unittest

from lab import match


def row(rule_id: str, status: str) -> dict:
    return {'ruleId': rule_id, 'rule': '', 'status': status, 'reason': '', 'agentQuote': '', 'title': ''}


class CountedTests(unittest.TestCase):
    def test_the_match_with_production_counts_in_no_status(self) -> None:
        rows = [row('rag:query', 'PASS'), row(match.CRITERION['id'], 'FAIL')]
        self.assertEqual(match.counted(rows), [row('rag:query', 'PASS')])


class SkippedTests(unittest.TestCase):
    def test_without_a_production_reply_the_match_does_not_apply(self) -> None:
        self.assertEqual(
            (match.skipped()['ruleId'], match.skipped()['status']), (match.CRITERION['id'], 'NOT_APPLICABLE')
        )
```

- [ ] **Step 2: Тесты повтора**

В `backend/tests/test_replay.py`:
- импорт: `from lab import llm, match, rag, replay, store`;
- в `CriteriaTests.test_without_checks_only_rag_criteria` ожидание: `[*rag.CRITERIA, match.CRITERION]`;
- в `test_accuracy_topic_rules_join_for_a_known_dialogue` ожидание:
  `['code:r1', *(r['id'] for r in rag.CRITERIA), match.CRITERION['id']]`;
- в `test_judge_failure_keeps_the_rows_unknown_and_the_step_unmeasured` в ожидаемый словарь добавить
  `match.CRITERION['id']: 'UNKNOWN'`.

В `RunTests` добавить:
```python
    async def test_a_reply_unlike_production_fails_no_step(self) -> None:
        async def unlike_production(rules: list[dict], step: dict, endpoint=None) -> Verdict:
            rows = [
                {
                    'ruleId': r['id'],
                    'rule': r['text'],
                    'status': 'FAIL' if r['id'] == match.CRITERION['id'] else 'PASS',
                    'reason': 'ok',
                    'agentQuote': 'x',
                    'title': '',
                }
                for r in rules
            ]
            return Verdict(rows, 'PASS', 'judge-model')

        result = await self.play(FakeAgent(), verdict=unlike_production)
        self.assertEqual(result['dialogues'][0]['steps'][0]['status'], 'PASS')

    async def test_the_match_does_not_apply_without_a_production_reply(self) -> None:
        result = await self.play(FakeAgent())
        rows = result['dialogues'][0]['steps'][1]['rules']
        self.assertEqual(next(r['status'] for r in rows if r['ruleId'] == match.CRITERION['id']), 'NOT_APPLICABLE')
```

- [ ] **Step 3: Тест Judge**

В `backend/tests/test_evaluation.py`, класс `StepVerdictTests`:
```python
    async def test_the_match_with_production_is_not_in_the_steps_status(self) -> None:
        answer = {
            'rules': [
                verdict('rag:query', 'PASS', 'вернуть платёж покупателю'),
                verdict(match.CRITERION['id'], 'FAIL', 'Откройте раздел'),
            ]
        }
        with patch.object(llm, 'chat', AsyncMock(return_value=completion(answer))):
            result = await judge.step_verdict([RAG_RULE, match.CRITERION], REPLAYED_STEP)
        self.assertEqual(result.status, 'PASS')
```
и импорт `match` в шапке файла рядом с остальными модулями `lab`.

- [ ] **Step 4: Тесты падают**

Run: `uv run --locked --directory backend python -m unittest tests.test_match tests.test_replay tests.test_evaluation -v`
Expected: FAIL — `ImportError: cannot import name 'match' from 'lab'`.

- [ ] **Step 5: `backend/lab/match.py`**

```python
"""Whether the replayed reply says what production said (spec 2026-10-06-acquiring-replay-service-design.md). The
trace of a replay explains production's reply only when the two match. The criterion is shown under the two replies
and counts in no status and no metric."""

FAMILY = 'replay'
CRITERION = {
    'id': f'{FAMILY}:match',
    'family': FAMILY,
    'name': 'Совпадение с продом',
    'observation': 'reply',
    'condition': 'В логе есть ответ агента в проде на это сообщение клиента (prodReply).',
    'text': 'Ответ агента на повторе по смыслу совпадает с ответом в проде (prodReply): то же действие, те же шаги, '
    'условия и суммы.',
    'acceptable': 'Другие слова и другой порядок. Другие данные клиента: в повторе системы банка отвечают тестовыми.',
    'quote': '',
}
NO_PROD_REPLY = 'В логе нет ответа прода на это сообщение.'


def skipped() -> dict:
    """The criterion on a step whose message production did not answer in the log."""
    return {
        'ruleId': CRITERION['id'],
        'rule': CRITERION['text'],
        'status': 'NOT_APPLICABLE',
        'reason': NO_PROD_REPLY,
        'agentQuote': '',
        'title': '',
    }


def counted(rows: list[dict]) -> list[dict]:
    """A step's rows that make its status: all but the match with production."""
    return [row for row in rows if not row['ruleId'].startswith(f'{FAMILY}:')]
```

- [ ] **Step 6: Judge и повтор**

`backend/lab/judge.py`: `from . import llm, logs, match, quotes, rag`; последняя строка `step_verdict`:
```python
    return Verdict(rows, verdict_of(match.counted(rows)), answer.model)
```

`backend/lab/replay.py`: импорт `from . import agents, discover, judge, llm, logs, match, rag, store, tone`.
В `criteria_by_dialogue` список критериев:
```python
        str(d['id']): [
            *tone_rules,
            *of_family('code', (topic_of.get(str(d['id'])) or {}).get('rules') or []),
            *rag.CRITERIA,
            match.CRITERION,
        ]
```
`_judge_step` целиком:
```python
async def _judge_step(rules: list[dict], step: dict, verdict: StepJudge) -> None:
    asked, skipped = _split(rules, step)
    if not asked:
        step.update(rules=skipped, status=judge.verdict_of(match.counted(skipped)), error=None)
        return
    try:
        result, second = await _both_judges(asked, step, verdict)
    except llm.ModelError as error:
        step.update(rules=judge.checked([], asked, '') + skipped, status='UNMEASURED', error=str(error))
        return
    rows = result.rows + skipped
    step.update(
        rules=rows, status=judge.verdict_of(match.counted(rows)), model=result.model, second=second, error=None
    )


def _split(rules: list[dict], step: dict) -> tuple[list[dict], list[dict]]:
    """The rules to ask the judge about, and the rows of those whose moment did not arise on this step."""
    rag_called = rag.called(step['trace'])
    asked, skipped = [], []
    for rule in rules:
        if rule['family'] == 'rag' and not rag_called:
            skipped.append(rag.skipped(rule))
        elif rule['family'] == match.FAMILY and step.get('prodReply') is None:
            skipped.append(match.skipped())
        else:
            asked.append(rule)
    return asked, skipped
```

- [ ] **Step 7: Тесты проходят**

Run: `uv run --locked --directory backend python -m unittest tests.test_match tests.test_replay tests.test_evaluation -v`
Expected: `OK`.

- [ ] **Step 8: Commit**

```bash
git add backend
git commit -m "replay:match says whether the replayed reply matches production's; it counts in no step status and no metric"
```

---

### Task 15: Что Judge видит из трейса

**Files:**
- Modify: `backend/lab/rag.py` (`CRITERIA` — `grounded`, `for_judge`)
- Test: `backend/tests/test_rag.py`

- [ ] **Step 1: Тесты**

В `backend/tests/test_rag.py`, в `TRACE`:
- в вызове `rag` строку `'status': 200,` заменить на `'source': 'idp', 'status': 'ok', 'request': {'message': {}},`;
- `'systems'` заменить на `[{'tool': 'getLkkTariff', 'arguments': {}, 'status': 'stubbed', 'response': {'tariff': '2%'}}]`.

В `test_judge_sees_chain_outputs_without_prompts` последнюю проверку заменить на:
```python
        self.assertEqual(shown['systems'], [{'tool': 'getLkkTariff', 'arguments': {}, 'response': {'tariff': '2%'}}])
```
Добавить класс:
```python
class StandTraceTests(unittest.TestCase):
    def test_the_judge_sees_where_an_answer_came_from_and_whether_the_call_ended(self) -> None:
        call = rag.for_judge(TRACE)['rag'][0]
        self.assertEqual((call['source'], call['status']), ('idp', 'ok'))

    def test_the_judge_does_not_get_the_request_with_its_prompts(self) -> None:
        self.assertNotIn('request', rag.for_judge(TRACE)['rag'][0])

    def test_the_judge_sees_the_bank_systems_data(self) -> None:
        self.assertEqual(rag.for_judge(TRACE)['systems'][0]['response'], {'tariff': '2%'})

    def test_an_answer_from_the_cache_is_a_knowledge_base_call(self) -> None:
        cached = {'rag': [{'source': 'cache', 'query': 'q', 'passages': [], 'answer': 'a'}]}
        self.assertTrue(rag.called(cached))
```

- [ ] **Step 2: Тесты падают**

Run: `uv run --locked --directory backend python -m unittest tests.test_rag -v`
Expected: FAIL — `KeyError: 'source'`.

- [ ] **Step 3: Реализация**

В `rag.for_judge`:
```python
        'rag': [
            {key: call.get(key) for key in ('source', 'status', 'query', 'filter', 'passages', 'answer', 'reason')}
            for call in trace.get('rag') or []
        ],
        'systems': [
            {key: call.get(key) for key in ('tool', 'arguments', 'response')} for call in trace.get('systems') or []
        ],
```
Критерий `grounded` в `CRITERIA`:
```python
    _criterion(
        'grounded',
        'Ответ опирается на найденное',
        'reply',
        CALLED,
        'Каждое утверждение ответа агента о шагах, разделах, сроках, суммах и условиях есть в найденных фрагментах '
        'или в данных систем банка (trace.systems).',
        'Данные клиента из систем банка: номера терминалов, статусы, договоры.',
    ),
```

- [ ] **Step 4: Тесты проходят**

Run: `uv run --locked --directory backend python -m unittest tests.test_rag tests.test_replay -v`
Expected: `OK`.

- [ ] **Step 5: Commit**

```bash
git add backend
git commit -m "The judge sees whether a knowledge-base answer came from IDP or its cache and whether the call ended, and the bank systems' data; not the IDP request with its prompts"
```

---

### Task 16: Judge получает ответ повтора и ответ прода

**Files:**
- Modify: `backend/lab/judge.py` (`step_verdict`), `backend/lab/prompts.py` (`JUDGE_REPLAY`)
- Test: `backend/tests/test_evaluation.py`

- [ ] **Step 1: Тесты**

В `StepVerdictTests`:
- `test_payload_shows_the_step_and_its_trace` ожидание:
  `['expectations', 'history', 'customerMessage', 'replayReply', 'prodReply', 'trace']`;
- добавить:
```python
    async def test_payload_carries_productions_reply(self) -> None:
        answer = {'rules': [verdict('rag:query', 'PASS', 'вернуть платёж покупателю')]}
        model = AsyncMock(return_value=completion(answer))
        with patch.object(llm, 'chat', model):
            await judge.step_verdict([RAG_RULE], {**REPLAYED_STEP, 'prodReply': 'Возврат — в разделе «Операции».'})
        self.assertEqual(json.loads(model.call_args.args[1])['prodReply'], 'Возврат — в разделе «Операции».')
```

- [ ] **Step 2: Тесты падают**

Run: `uv run --locked --directory backend python -m unittest tests.test_evaluation -v`
Expected: FAIL — в payload `agentReply`.

- [ ] **Step 3: Реализация**

В `judge.step_verdict` словарь `payload`:
```python
    payload = {
        'expectations': rules,
        'history': shown_history,
        'customerMessage': step['customer'],
        'replayReply': {'text': reply['text'], 'status': reply['status'], 'buttons': reply.get('options') or []},
        'prodReply': step.get('prodReply'),
        'trace': rag.for_judge(trace),
    }
```
Docstring `step_verdict`:
```python
    """One step of a replayed conversation (replay.py): the agent's new reply and its trace against the rules, with
    production's reply for the match with it (match.py)."""
```
`JUDGE_REPLAY` в `backend/lab/prompts.py` целиком:
```python
JUDGE_REPLAY = """Evaluate only the supplied expectations against ONE step of a conversation from production logs, replayed through the agent just now.
history is the conversation before this step, as it happened in production: context only, never judged. customerMessage is the customer's next message from the logs. replayReply is what the agent answered to it just now: judge only replayReply.
prodReply is what the agent answered to the same message in production (null if the log has none). Use it only for rules about matching production; it is never evidence for other rules.
trace is what happened inside the agent on this replayed step, not in production: chains (its internal model steps and their outputs), rag (each knowledge-base answer: source "idp" for a call to the knowledge base or "cache" for an answer taken from its warmed cache; status "ok", "error", "timeout" or "cancelled"; the query, the passages found, the knowledge base's answer, reason when nothing was found) and systems (bank system calls with the data they returned).
The bank systems answered with test data. Customer data in replayReply (terminal numbers, statuses, contracts) that is in trace.systems is grounded, not invented.
For each rule return exactly one row. Apply its condition first; if the moment did not arise on this step, return NOT_APPLICABLE. If uncertain, UNKNOWN.
FAIL requires a real contradiction of an applicable rule. PASS requires evidence, not an agreeable-looking answer. A handoff may be allowed: respect rule exceptions and acceptable alternatives. Never force pass/fail.
A status other than 200 in replayReply means the agent did not answer itself: 202-x hands the customer to an operator.
The export masks personal data and every digit: * and # are hidden values, not missing ones.
Each PASS/FAIL must cite in agentQuote an EXACT substring (copy it character by character) of the evidence the rule's observation names: "reply" — replayReply.text or a button; "rag" — the rag query, a passage text or the rag answer; "tool" — a system name from trace.systems. Never invent a quote.
Rules with observation "knowledge" are judged against the rag passages: FAIL only for a concrete contradiction or an invented step, menu or section name, deadline, amount or condition the passages do not contain.
Use Russian. Return {rules:[{ruleId,status:"PASS|FAIL|UNKNOWN|NOT_APPLICABLE",reason,agentQuote,title}]}.
title describes a concrete recurring failure pattern for FAIL. reason: one or two short sentences a business owner understands."""
```

- [ ] **Step 4: Тесты проходят**

Run: `uv run --locked --directory backend python -m unittest tests.test_evaluation tests.test_replay -v`
Expected: `OK`.

- [ ] **Step 5: Commit**

```bash
git add backend
git commit -m "The judge of a replayed step gets the replay's reply and production's, and knows the trace and the bank data belong to the replay"
```

---

### Task 17: Сервис повтора как способ подключения

**Files:**
- Create: `backend/lab/agents/replay_service.py`, `backend/tests/test_replay_service.py`
- Modify: `backend/lab/settings.py`, `backend/lab/agents/http.py` (`traced`), `backend/lab/agents/__init__.py`,
  `backend/lab/replay.py` (`traced`, тексты, `stand`), `backend/lab/api.py`
- Test: `backend/tests/test_replay.py`

- [ ] **Step 1: Тесты сервиса**

`backend/tests/test_replay_service.py`:
```python
import json
import os
import unittest
from unittest.mock import patch

import httpx

from lab import agents
from lab.agents import AgentError
from lab.agents.replay_service import ReplayServiceAgent

WARMING = 'Кэш базы знаний ещё прогревается.'
TRACE = {'traceId': 't', 'chains': [], 'rag': [{'source': 'idp', 'query': 'как вернуть терминал'}], 'systems': []}


def agent_reply(status: int = 200, code: str = '200', text: str = 'Верните терминал в отделение.') -> dict:
    return {'status': status, 'body': {'message': {'content': {'status_code': code, 'result': text}}}}


class FakeService:
    """The replay service in memory: ready or warming up, answering every turn with the agent's reply and a trace."""

    def __init__(self, ready: bool = True, turn_status: int = 200, reply: dict | None = None) -> None:
        self.ready, self.turn_status, self.reply, self.bodies = ready, turn_status, reply or agent_reply(), []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        if request.url.path == '/health':
            return httpx.Response(
                200,
                json={
                    'ready': self.ready,
                    'problems': [] if self.ready else [WARMING],
                    'prompts': {'version': '0.0.1', 'hashes': {}},
                    'idpCache': {'total': 2, 'warmed': 2, 'failed': []},
                    'isolation': ['sbe:stub'],
                },
            )
        self.bodies.append(json.loads(request.content))
        if self.turn_status != 200:
            return httpx.Response(self.turn_status, json={'problems': [WARMING]})
        return httpx.Response(200, json={'agent': self.reply, 'seconds': 1.5, 'trace': TRACE})


def replay_agent(service: FakeService) -> ReplayServiceAgent:
    return ReplayServiceAgent({'url': 'http://replay.stand:8080'}, transport=httpx.MockTransport(service))


class OpenTests(unittest.IsolatedAsyncioTestCase):
    async def test_a_service_not_ready_names_its_problems(self) -> None:
        with self.assertRaisesRegex(AgentError, 'прогревается'):
            await replay_agent(FakeService(ready=False)).open()

    async def test_the_agents_version_is_its_prompts_version(self) -> None:
        agent = replay_agent(FakeService())
        await agent.open()
        self.assertEqual(agent.version, '0.0.1')

    async def test_the_stand_keeps_the_cache_warm_up(self) -> None:
        agent = replay_agent(FakeService())
        await agent.open()
        self.assertEqual(agent.stand['idpCache'], {'total': 2, 'warmed': 2, 'failed': []})


class SayTests(unittest.IsolatedAsyncioTestCase):
    async def test_a_turn_gives_the_reply(self) -> None:
        reply = await replay_agent(FakeService()).say('c-1', 'как вернуть терминал', history=[])
        self.assertEqual((reply['text'], reply['status']), ('Верните терминал в отделение.', '200'))

    async def test_a_turn_gives_its_trace(self) -> None:
        reply = await replay_agent(FakeService()).say('c-1', 'как вернуть терминал', history=[])
        self.assertEqual(reply['trace'], TRACE)

    async def test_history_goes_as_the_bank_chats_phrases(self) -> None:
        service = FakeService()
        history = [{'role': 'customer', 'text': 'Здравствуйте'}, {'role': 'agent', 'text': 'Чем помочь?'}]
        await replay_agent(service).say('c-1', 'как вернуть терминал', history=history)
        message = service.bodies[0]['message']
        self.assertEqual((message['sender'], len(message['content']['phrases'])), ('GIGAASSISTANT', 3))

    async def test_an_agents_failure_is_its_reply_to_judge(self) -> None:
        service = FakeService(reply=agent_reply(500, '500-2', 'Внутренняя ошибка агента'))
        reply = await replay_agent(service).say('c-1', 'как вернуть терминал', history=[])
        self.assertEqual(reply['status'], '500-2')

    async def test_a_service_gone_unready_is_an_agent_error(self) -> None:
        with self.assertRaisesRegex(AgentError, 'прогревается'):
            await replay_agent(FakeService(turn_status=503)).say('c-1', 'как вернуть терминал', history=[])

    async def test_a_scenarios_test_data_is_refused(self) -> None:
        with self.assertRaises(AgentError):
            await replay_agent(FakeService()).say('c-1', 'тариф', world={'getLkkTariff': {}}, history=[])


class ReplayTargetsTests(unittest.TestCase):
    def test_the_service_is_offered_for_replays_when_its_address_is_set(self) -> None:
        with patch.dict(os.environ, {'LAB_REPLAY_URL': 'http://replay.stand:8080'}):
            self.assertIn(agents.REPLAY_SERVICE, [t['id'] for t in agents.replay_targets()])

    def test_the_service_is_not_offered_without_an_address(self) -> None:
        with patch.dict(os.environ, {'LAB_REPLAY_URL': ''}):
            self.assertNotIn(agents.REPLAY_SERVICE, [t['id'] for t in agents.replay_targets()])

    def test_the_service_is_not_a_way_to_talk_to_the_agent(self) -> None:
        self.assertNotIn(agents.REPLAY_SERVICE, agents.configs())
```

- [ ] **Step 2: Тесты повтора**

В `backend/tests/test_replay.py`:
- в `FakeAgent` строку `mocked = True` заменить на `traced = True`;
- `test_remote_agent_is_refused`: `agent.mocked = False` → `agent.traced = False`; `assertRaisesRegex(RuntimeError, 'трейс')`;
- добавить в `RunTests`:
```python
    async def test_the_result_keeps_what_the_stand_said_about_itself(self) -> None:
        agent = FakeAgent()
        agent.stand = {'prompts': {'version': '0.0.1'}, 'idpCache': {'total': 2, 'warmed': 1, 'failed': ['tariff']}}
        result = await self.play(agent)
        self.assertEqual(result['stand'], agent.stand)
```

- [ ] **Step 3: Тесты падают**

Run: `uv run --locked --directory backend python -m unittest tests.test_replay_service tests.test_replay -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'lab.agents.replay_service'`.

- [ ] **Step 4: Адрес сервиса**

`backend/lab/settings.py`, в конец:
```python
def replay_url() -> str:
    """The replay service on the stand (aigw-local replay/), its origin: http://host:port. Read at every use, so the
    Lab picks a new address up without a restart of its code paths that cache nothing."""
    return os.environ.get('LAB_REPLAY_URL', '').strip()
```

- [ ] **Step 5: `backend/lab/agents/replay_service.py`**

```python
"""The replay service on the stand (aigw-local replay/, spec 2026-10-06-acquiring-replay-service-design.md): the
acquiring agent that writes nothing outside itself, one call per turn answering with the reply and its trace."""

import httpx

from ..settings import AGENT_TIMEOUT
from .http import AgentError, address_valid, local_request, read_reply

NO_ADDRESS = 'Не задан адрес сервиса повтора. Укажите его в LAB_REPLAY_URL.'
NOT_READY = 'Сервис повтора не готов. {}'
NO_WORLD = 'Сервис повтора не принимает тестовые данные сценария: системы банка в нём отвечают одними данными.'
NOT_JSON = 'Сервис повтора ответил не в JSON.'
UNKNOWN_SHAPE = 'Сервис повтора ответил в неизвестном формате.'


class ReplayServiceAgent:
    """Replays only: a turn comes with its trace (traced), the bank systems behind it are fixed, not a scenario's."""

    traced = True
    mocked = False

    def __init__(self, config: dict, transport: httpx.AsyncBaseTransport | None = None) -> None:
        self.url = (config.get('url') or '').rstrip('/')
        self.version = 'не сообщается'
        self.stand: dict | None = None
        self._transport = transport  # a test's service in memory; None — the network

    async def open(self) -> None:
        if not address_valid(self.url):
            raise AgentError(NO_ADDRESS)
        health = await self._call('GET', '/health', timeout=httpx.Timeout(10))
        if not health.get('ready'):
            raise AgentError(NOT_READY.format(' '.join(health.get('problems') or [])))
        self.version = str((health.get('prompts') or {}).get('version') or self.version)
        self.stand = {key: health.get(key) for key in ('prompts', 'idpCache', 'isolation')}

    async def close(self) -> None:
        pass

    async def say(
        self, conversation_id: str, text: str, world: dict | None = None, history: list[dict] | None = None
    ) -> dict:
        """One turn: the reply as the agent gave it (an error status is its reply too), seconds taken, the trace."""
        if world:
            raise AgentError(NO_WORLD)
        _, body = local_request(conversation_id, text, history)
        answer = await self._call('POST', '/replay/turn', body=body, timeout=httpx.Timeout(AGENT_TIMEOUT, connect=10))
        agent = answer.get('agent') or {}
        reply = read_reply(agent.get('body'), int(agent.get('status') or 0))
        return {**reply, 'seconds': answer.get('seconds'), 'events': [], 'trace': answer.get('trace')}

    async def _call(self, method: str, path: str, *, timeout: httpx.Timeout, body: dict | None = None) -> dict:
        try:
            async with httpx.AsyncClient(base_url=self.url, timeout=timeout, transport=self._transport) as client:
                response = await client.request(method, path, json=body)
        except httpx.HTTPError as error:
            raise AgentError(f'Нет связи с сервисом повтора ({type(error).__name__}).') from error
        value = _object(response)
        if response.status_code == 503:
            raise AgentError(NOT_READY.format(' '.join(value.get('problems') or [])))
        if response.status_code != 200:
            raise AgentError(f'Сервис повтора ответил ошибкой (HTTP {response.status_code}).')
        return value


def _object(response: httpx.Response) -> dict:
    try:
        value = response.json()
    except ValueError as error:
        raise AgentError(NOT_JSON) from error
    if not isinstance(value, dict):
        raise AgentError(UNKNOWN_SHAPE)
    return value
```

- [ ] **Step 6: `traced` у агента по HTTP**

`backend/lab/agents/http.py`, в класс `HttpAgent` после `mocked`:
```python
    @property
    def traced(self) -> bool:
        """It gives the trace of a replayed turn: the local agent with its trace harness does."""
        return self.mocked
```

- [ ] **Step 7: `backend/lab/agents/__init__.py`**

Импорты:
```python
from .. import store
from ..settings import replay_url
from .http import AGENT_PATH, BAD_ADDRESS, AgentError, HttpAgent, address_valid
from .replay_service import ReplayServiceAgent
from .session import session
from .source import START, CodeAgent
```
После `SETTINGS`/`DEFAULT_REPO`:
```python
REPLAY_SERVICE = 'replay-service'
Agent = HttpAgent | ReplayServiceAgent
```
`NAMES`:
```python
NAMES = {
    'prod': 'Тестовый стенд банка',
    'local-http': 'На этом компьютере',
    'local-code': 'Запуск из кода',
    REPLAY_SERVICE: 'Сервис повтора на стенде',
}
```
После `configs()`:
```python
def replay_config() -> dict:
    return {
        'name': NAMES[REPLAY_SERVICE],
        'kind': 'replay',
        'profile': 'replay',
        'url': replay_url(),
        'note': 'Агент эквайринга на стенде. Во внешние системы не пишет, трейс отдаёт на каждом шаге.',
    }


def replay_targets() -> list[dict]:
    """The ways a replay reaches the agent: set up and giving their trace. The replay service is only here: it replays
    recorded conversations and does not talk."""
    shown = [public(key, config) for key, config in {**configs(), REPLAY_SERVICE: replay_config()}.items()]
    return [target for target in shown if target['ready'] and (target['local'] or target['kind'] == 'replay')]
```
`create`:
```python
def create(key: str) -> Agent:
    if key == REPLAY_SERVICE:
        return ReplayServiceAgent(replay_config())
    config = configs().get(key)
    if not config:
        raise AgentError(f'Неизвестный способ подключения агента: {key}.')
    return CodeAgent(config) if config['kind'] == 'code' else HttpAgent(config)
```
В `__all__` добавить `'REPLAY_SERVICE'`, `'Agent'`, `'ReplayServiceAgent'`, `'replay_targets'`.

- [ ] **Step 8: `backend/lab/replay.py`**

```python
NOT_LOCAL = 'Повтор работает с агентом, который отдаёт трейс: на этом компьютере или сервисом повтора на стенде.'
NO_TRACE = 'Агент не отдаёт трейс. Обновите aigw-local: нужен replay/recorder.py.'
```
Сигнатура `run`: `create: Callable[[str], agents.Agent] = agents.create,`; проверка:
```python
    agent = create(target)
    if not agent.traced:
        raise RuntimeError(NOT_LOCAL)
```
В словарь `value` после `'version': agent.version,`:
```python
        'stand': getattr(agent, 'stand', None),
```
Аннотации `agents.HttpAgent` в `_replay_dialogue` и `_play_step` → `agents.Agent`.

- [ ] **Step 9: `backend/lab/api.py`**

В `/api/state` после `'targets': …`:
```python
        'replayTargets': agents.replay_targets(),
```
`start_replay`:
```python
@app.post('/api/replay')
async def start_replay(payload: ReplayCommand) -> dict:
    if payload.target not in {*agents.configs(), agents.REPLAY_SERVICE}:
        raise HTTPException(400, UNKNOWN_WAY)
    return start('replay', lambda progress: replay.run(payload.target, payload.count, progress))
```

- [ ] **Step 10: Тесты проходят**

Run: `uv run --locked --directory backend python -m unittest discover -s tests -v`
Expected: `OK`.

- [ ] **Step 11: Commit**

```bash
git add backend
git commit -m "Replays reach the agent through the replay service on the stand (LAB_REPLAY_URL): ready by its health, one call a turn, its prompts version and cache warm-up kept with the result"
```

---

### Task 18: Интерфейс повтора

**Files:**
- Modify: `frontend/src/lab/types.ts`, `frontend/src/lab/replay.ts`, `frontend/src/sections/replay/ReplayPage.tsx`,
  `frontend/src/sections/replay/StepView.tsx`

- [ ] **Step 1: Типы**

`frontend/src/lab/types.ts`:
```ts
export type RagCall = {
  seq?: number;
  /** idp: a call to the knowledge base; cache: an answer from its warmed cache, no call made. Older traces have none. */
  source?: "idp" | "cache";
  /** ok, error, timeout, cancelled; an HTTP status in older traces. */
  status: string | number;
  /** The request to IDP as sent; none for a cached answer. */
  request?: unknown;
  query: string;
  filter: string | null;
  systemPrompt: string;
  passages: RagPassage[];
  answer: string;
  reason: string | null;
};
export type AgentTrace = {
  traceId: string;
  chains: { seq?: number; name: string; output: string | null; seconds?: number; error?: string }[];
  rag: RagCall[];
  systems: { seq?: number; tool: string; arguments: unknown; status: number | string; response?: unknown }[];
};
```
В `ReplayResult` после `version: string;`:
```ts
  /** What the replay service said of itself before the replay; none for an agent on this computer. */
  stand?: {
    prompts?: { version: string };
    idpCache?: { total: number; warmed: number; failed: string[] };
  } | null;
```
В `LabState` после `targets: Target[];`:
```ts
  /** The ways a replay reaches the agent (backend agents.replay_targets). Older services have no such field. */
  replayTargets?: Target[];
```

- [ ] **Step 2: `frontend/src/lab/replay.ts`**

После `familyOf`:
```ts
/** The match of the replayed reply with production's (backend lab/match.py): shown under the replies, in no score. */
export const MATCH_ID = "replay:match";
```

- [ ] **Step 3: `ReplayPage.tsx`**

Удалить `replayTargets` и его комментарий. `defaultTarget`:
```tsx
/** The replay service on the stand first: it replays the agent as production runs it. */
const defaultTarget = (targets: Target[]) =>
  (targets.find((t) => t.kind === "replay") ?? targets.find((t) => t.kind === "code") ?? targets[0])?.id ?? "";
```
В `StartForm`: `const targets = state?.replayTargets ?? [];`. Текст при пустом списке:
```tsx
        <p className="w-full text-body text-fg-2">
          Нет агента, который отдаёт трейс. Задайте адрес сервиса повтора в LAB_REPLAY_URL или{" "}
          <Link to={SECTIONS.agent} className={LINK}>
            настройте агента на этом компьютере
          </Link>
          .
        </p>
```
В `Result` строку с версией:
```tsx
      <p className="text-small text-fg-3">
        Повтор {longDay(result.finishedAt)} в {time(result.finishedAt)} · версия агента {result.version || "—"}
        {result.stand?.idpCache &&
          ` · кэш базы знаний: ${result.stand.idpCache.warmed} из ${result.stand.idpCache.total}`}
      </p>
```
Комментарий над `ReplayPage` поправить: «Conversations of the export play again through an agent that gives its trace:
the replay service on the stand or the local agent.»

- [ ] **Step 4: `StepView.tsx`**

Импорт: `import { familyOf, FAMILY_NAME, MATCH_ID } from "../../lab/replay";`.

Над `Trace`:
```tsx
const CALL_WORD: Record<string, string> = {
  error: "База знаний ответила ошибкой.",
  timeout: "База знаний не ответила вовремя.",
  cancelled: "Запрос отменён: агент ответил раньше.",
};

function CallNote({ call }: { call: RagCall }) {
  if (call.source === "cache") return <p className="text-fg-3">Ответ из кэша базы знаний, без запроса.</p>;
  const word = typeof call.status === "string" ? CALL_WORD[call.status] : undefined;
  return word ? <p className="text-bad">{word}</p> : null;
}
```
`RagCall` добавить в импорт типов. В `Trace`, внутри `trace.rag.map(...)` сразу после открывающего `<div key={i} …>`:
```tsx
          <CallNote call={call} />
```
и после блока «Ответ базы знаний»:
```tsx
          {call.request != null && (
            <details>
              <summary className="cursor-pointer text-fg-3">Запрос в базу знаний целиком</summary>
              <pre className="mt-1 whitespace-pre-wrap break-all">{JSON.stringify(call.request, null, 2)}</pre>
            </details>
          )}
```
Строку о системах банка:
```tsx
      {trace.systems.length > 0 && (
        <p className="mt-3">
          <span className="text-fg-3">Системы банка: </span>
          {trace.systems.map((s) => s.tool).join(", ")}
          {trace.systems.some((s) => s.status === "stubbed") && (
            <span className="text-fg-3"> (тестовые данные)</span>
          )}
        </p>
      )}
```
Над `Verdicts`:
```tsx
/** Whether the replayed reply matches production's: under the two replies, never among the verdicts. */
function Match({ rules }: { rules?: Rule[] }) {
  const row = rules?.find((r) => r.ruleId === MATCH_ID);
  if (!row || row.status === "NOT_APPLICABLE") return null;
  const line =
    row.status === "PASS"
      ? "Совпадает с ответом в проде."
      : row.status === "FAIL"
        ? "Отличается от ответа в проде."
        : "Не удалось сравнить с ответом в проде.";
  return (
    <p className="text-small text-fg-2">
      {line}
      {row.reason && ` ${row.reason}`}
    </p>
  );
}
```
В `Verdicts`:
```tsx
  const shown = rules.filter((r) => r.status !== "NOT_APPLICABLE" && r.ruleId !== MATCH_ID);
```
В `StepView` после блока с двумя `Reply`:
```tsx
      <Match rules={step.rules} />
```

- [ ] **Step 5: Сборка и линт**

Run: `npm --prefix frontend run lint && npm --prefix frontend run format:check && npm --prefix frontend run build`
Expected: без ошибок. Если `format:check` ругается — `npm --prefix frontend run format` и повторить.

- [ ] **Step 6: Commit**

```bash
git add frontend
git commit -m "«Повтор разговоров» offers the replay service first, shows whether a reply matches production's under the two replies, a cached or failed knowledge-base call, the IDP request in full and the stand's test data"
```

---

### Task 19: Отчёт об окружении и общая проверка

**Files:**
- Modify: `bin/replay_env_report.py`

- [ ] **Step 1: Отчёт ищет новую обвязку**

В `bin/replay_env_report.py`:
```python
AGENT_BRANCH = 'feat/replay-service'
```
В `trace_harness` список файлов:
```python
    files = ['local/run-app.sh', 'local/agent_lab_app.py', 'replay/recorder.py', 'replay/app.py', 'local/stubs/aef_tracing']
```
В `lab_setup` кортеж переменных окружения:
```python
    for key in ('LAB_MODEL_URL', 'LAB_MODEL', 'LAB_SECOND_MODEL', 'LAB_SECOND_URL', 'LAB_DATA', 'LAB_PORT', 'LAB_REPLAY_URL'):
```

- [ ] **Step 2: Общая проверка Lab**

Run: `bin/check.sh`
Expected: все шаги без ошибок (ruff, format, unittest, copy_check, lint, format, build). `copy_check` проверяет
новые тексты: `NOT_READY`, `NO_WORLD`, `NO_PROD_REPLY`, подписи в `StepView`. Найденную примету переписать по
`docs/WRITING.md`.

- [ ] **Step 3: Сквозной прогон на ноутбуке**

1. В aigw-local: `./local/run-mocks.sh` и `REPLAY_ALLOW_CODE_PROMPTS=True ./replay/run.sh`.
2. В Lab: `LAB_REPLAY_URL=http://127.0.0.1:8082` при запуске бэкенда (как обычно запускается Lab, с этой переменной).
3. «Повтор разговоров» → в списке агентов есть «Сервис повтора на стенде», он выбран по умолчанию → «Повторить»,
   2 разговора.

Expected: повтор завершается. У шагов есть «Ответ в проде» и «Ответ сейчас». Под ними строка «Совпадает…» или
«Отличается…» (кроме шагов без ответа прода). В трейсе у систем банка написано «(тестовые данные)». В строке итога
есть «кэш базы знаний: N из M».

- [ ] **Step 4: Commit**

```bash
git add bin/replay_env_report.py
git commit -m "The replay environment report looks for the replay service in aigw-local and shows LAB_REPLAY_URL"
```
