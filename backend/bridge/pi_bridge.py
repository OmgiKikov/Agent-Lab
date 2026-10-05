"""An OpenAI-compatible chat endpoint on top of Pi: each call is one tool-free Pi turn.

On a computer without the bank's model gateway, the judges and the synthetic customer reach OpenRouter models
through it (bin/start.sh starts one bridge per judge). Pi keeps the provider credentials; the bridge never sees them.
PI_PROXY_PORT, PI_JUDGE_PROVIDER, PI_JUDGE_MODEL, PI_PROXY_CONCURRENCY, PI_PROXY_TOKEN (bin/start.sh makes a new one
for each start; without one the bridge does not start). Only this computer's own names are served: a page that rebinds
its name to 127.0.0.1 is refused. The conversation reaches Pi on its standard input and the system prompt in a file
only this user reads: never on a command line, which every user of the computer sees and which Linux cuts at 128 KiB.
"""

import hmac
import json
import logging
import os
import shutil
import subprocess
import tempfile
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
HOSTS = ('127.0.0.1', 'localhost')
logger = logging.getLogger(__name__)


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
    with tempfile.TemporaryDirectory(prefix='pi-bridge-') as folder:  # owner-only, removed with the call
        prompt = Path(folder) / 'system.md'
        prompt.write_text('\n\n'.join(system) or 'Answer the user request precisely.', encoding='utf-8')
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
            # Pi reads a --system-prompt that names a file from the file; the conversation it reads from stdin.
            *('--system-prompt', str(prompt)),
        ]
        with SLOTS:
            result = subprocess.run(
                command,
                cwd=HERE,
                input='\n\n'.join(turns),
                capture_output=True,
                encoding='utf-8',
                errors='replace',
                timeout=TIMEOUT,
                check=False,
            )
    if result.returncode:
        raise RuntimeError(f'Pi failed with exit code {result.returncode}')  # its output may quote the conversation
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

    def refused_host(self) -> bool:
        """Refuse a request under a name other than this computer's (a page that rebound its own name to 127.0.0.1);
        True when refused."""
        if (self.headers.get('Host') or '').rsplit(':', 1)[0].lower() in HOSTS:
            return False
        self.error(403, 'Only 127.0.0.1 and localhost are served')
        return True

    def do_GET(self) -> None:
        if self.refused_host():
            return
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
        if self.refused_host():
            return
        given = (self.headers.get('Authorization') or '').encode()
        if not hmac.compare_digest(given, f'Bearer {TOKEN}'.encode()):
            self.error(401, 'Local bridge token required')
            return
        if self.path.rstrip('/') != '/v1/chat/completions':
            self.error(404, 'Not found')
            return
        try:
            length = int(self.headers.get('Content-Length', '0'))
        except ValueError:
            length = -1
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
            # The kind only: a timeout's text is the whole command line, the customer's conversation included.
            logger.error('Pi request failed: %s', type(error).__name__)
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
        logger.info('Pi answered in %.1fs', time.monotonic() - started)


if __name__ == '__main__':
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
    if not PI_BIN.is_file():
        raise SystemExit(f'Pi is missing: {PI_BIN} (npm ci in bridge/)')
    if not os.environ.get('PI_PROXY_TOKEN'):
        # A token everybody knows lets any program on this computer spend OpenRouter through the bridge.
        raise SystemExit('PI_PROXY_TOKEN is not set: start the bridges with bin/start.sh, or set it for both sides')
    logger.info('Pi model bridge on http://127.0.0.1:%s/v1 · %s %s', PORT, PROVIDER, MODEL)
    ThreadingHTTPServer(('127.0.0.1', PORT), Handler).serve_forever()
