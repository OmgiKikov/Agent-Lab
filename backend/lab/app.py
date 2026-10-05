"""One Python process serves the Lab: its HTTP routes and the built pages, on the settings it started with.

uvicorn lab.app:create --factory: the settings are read from the environment as the process starts (config.py) and
every request and job works with them; a test creates the app on its own.
"""

from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from urllib.parse import urlsplit

from fastapi import APIRouter, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from starlette.convertors import Convertor, register_url_convertor
from starlette.types import Scope

from . import api, config, storage
from .jobs import PerAgent
from .storage import registry

LOOPBACK = ('127.0.0.1', 'localhost', '::1')
DEFAULT_PORTS = {'http': 80, 'https': 443}
# No other page shows the Lab in a frame: a click a person makes there is a click on the Lab's own page, which the
# Origin check lets through (clickjacking). And a file the Lab serves is never read as another type.
HEADERS = {
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
}


def create(settings: config.Settings | None = None) -> FastAPI:
    """The Lab on these settings; without them, on the environment's."""
    app = FastAPI(title='Agent Lab', lifespan=lifespan)
    app.state.settings = settings or config.Settings.from_environment()
    # One owner of long work per agent: agents are checked in parallel, and each screen sees its own agent's work.
    app.state.jobs = PerAgent()
    app.include_router(api.router)
    # The one added last runs first: a request from a foreign page or name never reaches an agent's database.
    app.middleware('http')(in_context)
    app.middleware('http')(local_browser_commands)
    frontend = app.state.settings.frontend
    app.add_api_route('/health', health)
    if frontend and (frontend / 'assets').is_dir():
        app.mount('/assets', Assets(directory=frontend / 'assets'), name='assets')
    app.include_router(pages)
    return app


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """A second Lab on the same data starts nothing and recovers nothing (registry.only_process)."""
    with config.using(app.state.settings), registry.only_process():
        registry.adopt_legacy()
        registry.recover_lost()
        agents = registry.listed()
        if not agents and storage.db.default_database().exists():
            storage.runs.recover()  # before any agent: the default database, never created here
        for agent in agents:
            with registry.using(agent['id']):
                storage.runs.recover()
        try:
            yield
        finally:
            await app.state.jobs.close()


async def in_context(request: Request, call_next: Callable[[Request], Awaitable[Response]]) -> Response:
    """A request works with the Lab's settings and, on the product's API, inside one agent: the X-Agent header, or the
    first agent. The jobs it starts keep both."""
    with config.using(request.app.state.settings):
        path = request.url.path
        if not path.startswith('/api/') or path == '/api/agents':  # the list of agents is above any agent
            return await call_next(request)
        agent_id = request.headers.get('x-agent') or registry.default_id()
        if agent_id is None:
            return await call_next(request)
        if registry.get(agent_id) is None:
            return JSONResponse({'detail': 'Агент не найден'}, status_code=404)
        with registry.using(agent_id):
            return await call_next(request)


def allowed_hosts(settings: config.Settings) -> set[str]:
    """This computer's own names, and the ones a person adds in LAB_ALLOWED_HOSTS."""
    return {*LOOPBACK, *settings.allowed_hosts}


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


async def local_browser_commands(request: Request, call_next: Callable[[Request], Awaitable[Response]]) -> Response:
    """A page on another name that resolves to this computer (DNS rebinding) reads and changes nothing, pages
    included. A browser's command comes only from the Lab's own page: another local service on another port (Jupyter,
    a stand's Swagger) cannot replace the export or start paid work. A request without Origin is not a browser page's.
    """
    host = _host(request.headers.get('host', ''))
    if host is None or host[0] not in allowed_hosts(request.app.state.settings):
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


def health() -> dict:
    return {'status': 'ok', 'product': 'agent-lab'}


class Assets(StaticFiles):
    """Built files carry a hash in their names: a browser keeps them, the page itself is always revalidated."""

    async def get_response(self, path: str, scope: Scope) -> Response:
        response = await super().get_response(path, scope)
        if response.status_code == 200:
            response.headers['Cache-Control'] = 'public, max-age=31536000, immutable'
        return response


class Page(Convertor):
    """A path of the product's pages: never the API's nor the built files', so a request to them that matches no route
    is answered as such (404, or 405 for a known one asked with another method), never with the page."""

    regex = r'(?!api(?:/|$)|assets/).*'

    def convert(self, value: str) -> str:
        return value

    def to_string(self, value: str) -> str:
        return value


register_url_convertor('page', Page())
pages = APIRouter()


@pages.get('/favicon.svg')
def favicon(request: Request) -> FileResponse:
    frontend = request.app.state.settings.frontend
    if frontend is None or not (frontend / 'favicon.svg').is_file():
        raise HTTPException(404, 'Not found')
    return FileResponse(frontend / 'favicon.svg')


@pages.get('/')
@pages.get('/{path:page}')
def page(request: Request, path: str = '') -> FileResponse:
    """Every page of the product is the same built page, drawn by the browser's router (/overview, /logs/…,
    /simulations/…, and the earlier /lab/… addresses it redirects)."""
    frontend = request.app.state.settings.frontend
    index = frontend / 'index.html' if frontend else None
    if index is None or not index.is_file():
        raise HTTPException(503, 'Интерфейс не собран. Выполните npm --prefix frontend run build.')
    # After a rebuild the browser asks again and gets the new page, never yesterday's interface from its cache.
    return FileResponse(index, headers={'Cache-Control': 'no-cache'})
