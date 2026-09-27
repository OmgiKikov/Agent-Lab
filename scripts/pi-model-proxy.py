#!/usr/bin/env python3
"""Local OpenAI-compatible endpoint that runs one tool-free Pi turn per call."""

import json
import os
import shutil
import subprocess
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Lock


ROOT = Path(__file__).resolve().parent.parent
PI_BIN = Path(os.environ.get("PI_BIN", ROOT / "node_modules/.bin/pi"))
PORT = int(os.environ.get("PI_PROXY_PORT", "11435"))
MODEL = os.environ.get("PI_JUDGE_MODEL", "gpt-5.6-sol")
LOCAL_TOKEN = os.environ.get("PI_PROXY_TOKEN", "pi-local-bridge")
RUN_LOCK = Lock()
MAX_BODY_BYTES = 2_000_000


def content_text(content: object) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(
            part.get("text", "") for part in content
            if isinstance(part, dict) and part.get("type") in {"text", "input_text", "output_text"}
        )
    return ""


def forced_function(request: dict) -> tuple[str, dict] | None:
    for tool in request.get("tools") or []:
        if not isinstance(tool, dict) or tool.get("type") != "function":
            continue
        definition = tool.get("function") or tool
        name = definition.get("name")
        if name:
            return name, definition.get("parameters") or {}
    return None


def function_arguments(text: str, name: str, schema: dict) -> str:
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.split("\n", 1)[-1].rsplit("```", 1)[0].strip()
    try:
        value = json.loads(cleaned)
    except json.JSONDecodeError as error:
        raise ValueError(f"Pi did not return JSON for {name}: {error}") from error
    if not isinstance(value, dict):
        raise ValueError(f"Pi did not return an object for {name}")
    for field in schema.get("required", []):
        if field not in value:
            raise ValueError(f"Pi omitted required field {field} for {name}")
    allowed = (schema.get("properties") or {}).get("label", {}).get("enum")
    if allowed and value.get("label") not in allowed:
        raise ValueError(f"Pi returned an unknown category for {name}")
    return json.dumps(value, ensure_ascii=False)


def run_pi(request: dict) -> str:
    system = []
    turns = []
    instructions = request.get("instructions")
    if isinstance(instructions, str) and instructions:
        system.append(instructions)
    messages = request.get("messages")
    if messages is None:
        response_input = request.get("input", [])
        if isinstance(response_input, str):
            messages = [{"role": "user", "content": response_input}]
        elif isinstance(response_input, list):
            messages = response_input
        else:
            messages = []
    for message in messages:
        if not isinstance(message, dict):
            continue
        role = message.get("role", "user")
        body = content_text(message.get("content"))
        if role in {"system", "developer"}:
            system.append(body)
        elif body:
            turns.append(f"{role.upper()}:\n{body}")
    text_config = request.get("text") or {}
    forced = forced_function(request)
    if forced:
        name, schema = forced
        system.append(
            f"The caller requires a function call named {name}. Respond ONLY with a JSON object "
            f"that matches this schema: {json.dumps(schema, ensure_ascii=False)}. "
            "Do not add prose or markdown fences."
        )
    elif request.get("response_format") or text_config.get("format", {}).get("type") in {"json_object", "json_schema"}:
        system.append("Return only valid JSON in the format requested by the caller.")
    prompt = "\n\n".join(turns)
    if not prompt:
        raise ValueError("No text messages in request")

    command = [
        str(PI_BIN),
        "--provider", "openai-codex",
        "--model", MODEL,
        "--thinking", "low",
        "--no-tools",
        "--no-extensions",
        "--no-skills",
        "--no-context-files",
        "--no-prompt-templates",
        "--no-session",
        "--mode", "text",
        "--print",
        "--system-prompt", "\n\n".join(system) or "Answer the user request precisely.",
        "--",
        prompt,
    ]
    with RUN_LOCK:
        result = subprocess.run(
            command,
            cwd=ROOT,
            capture_output=True,
            text=True,
            timeout=240,
            check=False,
        )
    if result.returncode:
        raise RuntimeError(f"Pi failed with exit code {result.returncode}: {result.stderr[-400:]}")
    if not result.stdout.strip():
        raise RuntimeError("Pi returned an empty response")
    return result.stdout.strip()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format: str, *args: object) -> None:
        return

    def json_response(self, code: int, data: dict) -> None:
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        if self.path == "/health":
            if not PI_BIN.is_file() or not shutil.which("node"):
                self.json_response(503, {"status": "unavailable", "reason": "Pi or Node.js is missing"})
            else:
                self.json_response(200, {"status": "ok", "model": MODEL})
        elif self.path in {"/v1/models", "/models"}:
            self.json_response(200, {
                "object": "list",
                "data": [{"id": MODEL, "object": "model", "owned_by": "pi-local-bridge"}],
            })
        else:
            self.json_response(404, {"error": {"message": "Not found"}})

    def do_POST(self) -> None:
        if self.headers.get("Authorization") != f"Bearer {LOCAL_TOKEN}":
            self.json_response(401, {"error": {"message": "Local bridge token required"}})
            return
        endpoint = self.path.rstrip("/")
        if endpoint not in {"/v1/chat/completions", "/v1/responses"}:
            print(f"Unsupported Pi bridge path: POST {self.path}", file=sys.stderr, flush=True)
            self.json_response(404, {"error": {"message": "Not found"}})
            return
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0 or length > MAX_BODY_BYTES:
            self.json_response(413, {"error": {"message": "Invalid request size"}})
            return
        started = time.monotonic()
        try:
            request = json.loads(self.rfile.read(length))
            print(
                f"Pi request {endpoint}: keys={sorted(request)} input_type={type(request.get('input')).__name__} stream={bool(request.get('stream'))}",
                flush=True,
            )
            result = run_pi(request)
            request_id = f"chatcmpl-pi-{int(time.time() * 1000)}"
            forced = forced_function(request)
            arguments = function_arguments(result, *forced) if forced else None
            if forced and arguments:
                print(f"Pi selected category {json.loads(arguments).get('label', 'unknown')}", flush=True)
            if endpoint == "/v1/responses":
                response_id = request_id.replace("chatcmpl", "resp", 1)
                message_id = response_id.replace("resp", "msg", 1)
                response = {
                    "id": response_id,
                    "object": "response",
                    "created_at": int(time.time()),
                    "completed_at": int(time.time()),
                    "status": "completed",
                    "error": None,
                    "incomplete_details": None,
                    "instructions": request.get("instructions"),
                    "model": request.get("model", MODEL),
                    "output": ([{
                        "id": message_id,
                        "call_id": message_id.replace("msg", "call", 1),
                        "type": "function_call",
                        "status": "completed",
                        "name": forced[0],
                        "arguments": arguments,
                    }] if forced else [{
                        "id": message_id,
                        "type": "message",
                        "status": "completed",
                        "role": "assistant",
                        "content": [{"type": "output_text", "text": result, "annotations": []}],
                    }]),
                    "parallel_tool_calls": False,
                    "previous_response_id": None,
                    "store": False,
                    "temperature": request.get("temperature"),
                    "text": request.get("text", {"format": {"type": "text"}}),
                    "tool_choice": "none",
                    "tools": [],
                    "top_p": request.get("top_p", 1),
                    "truncation": "disabled",
                    "usage": {
                        "input_tokens": 0,
                        "output_tokens": 0,
                        "total_tokens": 0,
                        "input_tokens_details": {"cached_tokens": 0},
                        "output_tokens_details": {"reasoning_tokens": 0},
                    },
                }
                if request.get("stream"):
                    self.send_response(200)
                    self.send_header("Content-Type", "text/event-stream")
                    self.send_header("Cache-Control", "no-cache")
                    self.end_headers()
                    for event in (
                        {"type": "response.created", "response": {**response, "status": "in_progress", "output": []}},
                        {"type": "response.output_text.delta", "item_id": message_id, "output_index": 0, "content_index": 0, "delta": result},
                        {"type": "response.completed", "response": response},
                    ):
                        self.wfile.write(f"event: {event['type']}\ndata: {json.dumps(event, ensure_ascii=False)}\n\n".encode("utf-8"))
                    self.wfile.write(b"data: [DONE]\n\n")
                else:
                    self.json_response(200, response)
            elif request.get("stream"):
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Cache-Control", "no-cache")
                self.end_headers()
                for delta, finish in (({"role": "assistant", "content": result}, None), ({}, "stop")):
                    chunk = {
                        "id": request_id,
                        "object": "chat.completion.chunk",
                        "created": int(time.time()),
                        "model": MODEL,
                        "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
                    }
                    self.wfile.write(f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n".encode("utf-8"))
                self.wfile.write(b"data: [DONE]\n\n")
            else:
                self.json_response(200, {
                    "id": request_id,
                    "object": "chat.completion",
                    "created": int(time.time()),
                    "model": MODEL,
                    "choices": [{
                        "index": 0,
                        "message": ({
                            "role": "assistant",
                            "content": None,
                            "tool_calls": [{
                                "id": request_id.replace("chatcmpl", "call", 1),
                                "type": "function",
                                "function": {"name": forced[0], "arguments": arguments},
                            }],
                        } if forced else {"role": "assistant", "content": result}),
                        "finish_reason": "tool_calls" if forced else "stop",
                    }],
                    "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
                })
            print(f"Pi response sent in {time.monotonic() - started:.1f}s", flush=True)
        except (ValueError, json.JSONDecodeError) as error:
            self.json_response(400, {"error": {"message": str(error)}})
        except Exception as error:
            print(f"Pi request failed: {error}", file=sys.stderr, flush=True)
            self.json_response(502, {"error": {"message": "Pi model request failed"}})


if __name__ == "__main__":
    if not PI_BIN.is_file():
        raise SystemExit(f"Pi is missing: {PI_BIN}")
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"Pi model bridge listening on http://127.0.0.1:{PORT}/v1", flush=True)
    server.serve_forever()
