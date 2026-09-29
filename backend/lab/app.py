"""One Python process serves the Lab's HTTP routes and the built frontend."""

from fastapi import HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .api import app
from .settings import FRONTEND


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
@app.get('/lab')
@app.get('/lab/{path:path}')
def frontend(path: str = '') -> FileResponse:
    index = FRONTEND / 'index.html'
    if not index.is_file():
        raise HTTPException(503, 'Frontend не собран: выполните npm --prefix frontend run build')
    return FileResponse(index)
