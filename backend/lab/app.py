"""One Python process serves the Lab's HTTP routes and the built frontend."""

from collections.abc import Awaitable, Callable
from urllib.parse import urlsplit

from fastapi import HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from .api import app
from .settings import FRONTEND


@app.middleware('http')
async def local_browser_commands(request: Request, call_next: Callable[[Request], Awaitable[Response]]) -> Response:
    """Other browser tabs cannot launch model work on this local application."""
    origin = request.headers.get('origin')
    if request.method in ('POST', 'PUT', 'PATCH', 'DELETE') and origin:
        try:
            source = urlsplit(origin)
            allowed = source.scheme in ('http', 'https') and source.hostname in ('127.0.0.1', 'localhost', '::1')
        except ValueError:
            allowed = False
        if not allowed:
            return JSONResponse({'detail': 'Запрос из внешней страницы отклонён'}, status_code=403)
    return await call_next(request)


@app.get('/health')
def health() -> dict:
    return {'status': 'ok', 'product': 'agent-lab'}


if (FRONTEND / 'assets').is_dir():
    app.mount('/assets', StaticFiles(directory=FRONTEND / 'assets'), name='assets')


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
        raise HTTPException(503, 'Frontend не собран: выполните npm --prefix frontend run build')
    return FileResponse(index)
