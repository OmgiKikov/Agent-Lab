"""An OpenAI-compatible chat endpoint on top of Pi: each call is one tool-free Pi turn.

On a computer without the bank's model gateway, the judges and the synthetic customer reach OpenRouter models
through it (bin/start.sh starts one bridge per judge). Pi keeps the provider credentials; the bridge never sees them.
PI_PROXY_PORT, PI_JUDGE_PROVIDER, PI_JUDGE_MODEL, PI_PROXY_CONCURRENCY, PI_PROXY_TOKEN.
"""

import json
import os
import shutil
import subprocess
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import BoundedSemaphore

HERE = Path(__file__).resolve().parent
PI_BIN = Path(os.environ.get('PI_BIN', HERE / 'node_modules/.bin/pi'))
PORT = int(os.environ.get('PI_PROXY_PORT', '11436'))
PROVIDER = os.environ.get('PI_JUDGE_PROVIDER', 'openrouter')
MODEL = os.environ.get('PI_JUDGE_MODEL', 'z-ai/glm-5.3')
TOKEN = os.environ.get('PI_PROXY_TOKEN', 'pi-local-bridge')
SLOTS = BoundedSemaphore(max(1, int(os.environ.get('PI_PROXY_CONCURRENCY', '1'))))
MAX_BODY = 2_000_000
TIMEOUT = 240


def text_of(content: object) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = (p.get('text', '') for p in content if isinstance(p, dict) and p.get('type') in ('text', 'input_text'))
        return '\n'.join(parts)
    return ''


def run_pi(request: dict) -> str:
    system, turns = [], []
    for message in request.get('messages') or []:
        if not isinstance(message, dict):
            continue
        role, body = message.get('role', 'user'), text_of(message.get('content'))
        if role in ('system', 'developer'):
            system.append(body)
        elif body:
            turns.append(f'{role.upper()}:\n{body}')
    if (request.get('response_format') or {}).get('type') in ('json_object', 'json_schema'):
        system.append('Return only valid JSON in the format requested by the caller.')
    if not turns:
        raise ValueError('No text messages in the request')
    command = [
        str(PI_BIN),
        *('--provider', PROVIDER, '--model', MODEL, '--thinking', 'low'),
        *(
            '--no-tools',
            '--no-extensions',
            '--no-skills',
            '--no-context-files',
            '--no-prompt-templates',
            '--no-session',
        ),
        *('--mode', 'text', '--print'),
        *('--system-prompt', '\n\n'.join(system) or 'Answer the user request precisely.'),
        '--',
        '\n\n'.join(turns),
    ]
    with SLOTS:
        result = subprocess.run(command, cwd=HERE, capture_output=True, text=True, timeout=TIMEOUT, check=False)
    if result.returncode:
        raise RuntimeError(f'Pi failed with exit code {result.returncode}: {result.stderr[-400:]}')
    if not result.stdout.strip():
        raise RuntimeError('Pi returned an empty response')
    return result.stdout.strip()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format: str, *args: object) -> None:
        return

    def reply(self, code: int, data: dict) -> None:
        body = json.dumps(data, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def error(self, code: int, message: str) -> None:
        self.reply(code, {'error': {'message': message}})

    def do_GET(self) -> None:
        if self.path == '/health':
            if PI_BIN.is_file() and shutil.which('node'):
                self.reply(200, {'status': 'ok', 'model': MODEL})
            else:
                self.reply(503, {'status': 'unavailable', 'reason': 'Pi or Node.js is missing'})
        elif self.path in ('/v1/models', '/models'):
            self.reply(200, {'object': 'list', 'data': [{'id': MODEL, 'object': 'model', 'owned_by': 'pi'}]})
        else:
            self.error(404, 'Not found')

    def do_POST(self) -> None:
        if self.headers.get('Authorization') != f'Bearer {TOKEN}':
            self.error(401, 'Local bridge token required')
            return
        if self.path.rstrip('/') != '/v1/chat/completions':
            self.error(404, 'Not found')
            return
        length = int(self.headers.get('Content-Length', '0'))
        if not 0 < length <= MAX_BODY:
            self.error(413, 'Invalid request size')
            return
        started = time.monotonic()
        try:
            answer = run_pi(json.loads(self.rfile.read(length)))
        except (ValueError, json.JSONDecodeError) as error:
            self.error(400, str(error))
            return
        except (RuntimeError, OSError, subprocess.TimeoutExpired) as error:
            print(f'Pi request failed: {error}', file=sys.stderr, flush=True)
            self.error(502, 'Pi model request failed')
            return
        self.reply(
            200,
            {
                'id': f'chatcmpl-pi-{int(time.time() * 1000)}',
                'object': 'chat.completion',
                'created': int(time.time()),
                'model': MODEL,
                'choices': [{'index': 0, 'message': {'role': 'assistant', 'content': answer}, 'finish_reason': 'stop'}],
                'usage': {'prompt_tokens': 0, 'completion_tokens': 0, 'total_tokens': 0},
            },
        )
        print(f'Pi answered in {time.monotonic() - started:.1f}s', flush=True)


if __name__ == '__main__':
    if not PI_BIN.is_file():
        raise SystemExit(f'Pi is missing: {PI_BIN} (npm ci in bridge/)')
    print(f'Pi model bridge on http://127.0.0.1:{PORT}/v1 · {PROVIDER} {MODEL}', flush=True)
    ThreadingHTTPServer(('127.0.0.1', PORT), Handler).serve_forever()
