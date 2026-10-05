"""One Python process serves the Lab's HTTP routes and the built frontend."""

import os
from collections.abc import Awaitable, Callable
from urllib.parse import urlsplit

from fastapi import HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from starlette.types import Scope

from .api import app
from .settings import FRONTEND

LOOPBACK = ('127.0.0.1', 'localhost', '::1')
DEFAULT_PORTS = {'http': 80, 'https': 443}
# No other page shows the Lab in a frame: a click a person makes there is a click on the Lab's own page, which the
# Origin check lets through (clickjacking). And a file the Lab serves is never read as another type.
HEADERS = {
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
}


def allowed_hosts() -> set[str]:
    """This computer's own names, and the ones a person adds in LAB_ALLOWED_HOSTS (separated by commas or spaces)."""
    added = os.environ.get('LAB_ALLOWED_HOSTS', '').replace(',', ' ').split()
    return {*LOOPBACK, *(name.strip('[]').lower() for name in added)}


def _host(value: str) -> tuple[str, int | None] | None:
    """The name and port of a Host header; None unless it is one host with an optional port that is a number."""
    try:
        parts = urlsplit('//' + value)
        port = parts.port
    except ValueError:
        return None
    if parts.netloc != value or parts.username is not None or not parts.hostname:
        return None
    return parts.hostname, port


def _origin(value: str) -> tuple[str, str, int | None] | None:
    """Scheme, host and port of an Origin header; None for anything else (null, a path, a broken port)."""
    try:
        parts = urlsplit(value)
        port = parts.port
    except ValueError:
        return None
    if not parts.hostname or parts.username is not None or parts.path or parts.query or parts.fragment:
        return None
    return parts.scheme, parts.hostname, port or DEFAULT_PORTS.get(parts.scheme)


@app.middleware('http')
async def local_browser_commands(request: Request, call_next: Callable[[Request], Awaitable[Response]]) -> Response:
    """A page on another name that resolves to this computer (DNS rebinding) reads and changes nothing, pages
    included. A browser's command comes only from the Lab's own page: another local service on another port (Jupyter,
    a stand's Swagger) cannot replace the export or start paid work. A request without Origin is not a browser page's.
    """
    host = _host(request.headers.get('host', ''))
    if host is None or host[0] not in allowed_hosts():
        detail = 'Agent Lab открывается по адресу 127.0.0.1 или localhost. Другое имя добавьте в LAB_ALLOWED_HOSTS.'
        return JSONResponse({'detail': detail}, status_code=400)
    origin = request.headers.get('origin')
    if request.method in ('POST', 'PUT', 'PATCH', 'DELETE') and origin:
        scheme = request.scope['scheme']
        if _origin(origin) != (scheme, host[0], host[1] or DEFAULT_PORTS.get(scheme)):
            return JSONResponse({'detail': 'Запрос с чужой страницы отклонён.'}, status_code=403)
    response = await call_next(request)
    for name, value in HEADERS.items():
        response.headers.setdefault(name, value)
    return response


@app.get('/health')
def health() -> dict:
    return {'status': 'ok', 'product': 'agent-lab'}


class Assets(StaticFiles):
    """Built files carry a hash in their names: a browser keeps them, the page itself is always revalidated."""

    async def get_response(self, path: str, scope: Scope) -> Response:
        response = await super().get_response(path, scope)
        if response.status_code == 200:
            response.headers['Cache-Control'] = 'public, max-age=31536000, immutable'
        return response


if (FRONTEND / 'assets').is_dir():
    app.mount('/assets', Assets(directory=FRONTEND / 'assets'), name='assets')


@app.get('/favicon.svg')
def favicon() -> FileResponse:
    path = FRONTEND / 'favicon.svg'
    if not path.is_file():
        raise HTTPException(404, 'Not found')
    return FileResponse(path)


@app.get('/')
@app.get('/{path:path}')
def frontend(path: str = '') -> FileResponse:
    """Every page of the product is the same built page, drawn by the browser's router (/overview, /logs/…,
    /simulations/…, and the earlier /lab/… addresses it redirects). API and asset addresses are never pages."""
    if path == 'api' or path.startswith(('api/', 'assets/')):
        raise HTTPException(404, 'Not found')
    index = FRONTEND / 'index.html'
    if not index.is_file():
        raise HTTPException(503, 'Интерфейс не собран. Выполните npm --prefix frontend run build.')
    # After a rebuild the browser asks again and gets the new page, never yesterday's interface from its cache.
    return FileResponse(index, headers={'Cache-Control': 'no-cache'})
