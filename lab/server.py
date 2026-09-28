"""Agent Lab JSON API behind the Agent Lab section of Raindrop Workshop.

One background job at a time (a demo tool, not a scheduler).
"""
import asyncio

from fastapi import Body, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse

from . import cards, discover, llm, simulate, store, targets, workshop

app = FastAPI(title='Agent Lab')
# The Agent Lab section inside Raindrop Workshop (a different local origin) reads this API.
app.add_middleware(CORSMiddleware, allow_origins=['http://127.0.0.1:5899', 'http://localhost:5899'],
                   allow_methods=['GET', 'POST'], allow_headers=['Content-Type'])
job: dict = {'kind': None, 'running': False, 'error': None, 'progress': {}}


def _start(kind: str, factory) -> dict:
    if job['running']:
        raise HTTPException(409, 'Уже выполняется: ' + str(job['kind']))
    job.update(kind=kind, running=True, error=None, progress={'message': 'Запускаю…'})

    def progress(**values):
        job['progress'] = values

    async def body():
        try:
            await factory(progress)
        except Exception as error:  # surfaced on the page, never swallowed
            job['error'] = str(error) or type(error).__name__
        finally:
            job['running'] = False

    asyncio.get_running_loop().create_task(body())
    return {'ok': True}


def _run_summary(run: dict) -> dict:
    keys = ('id', 'target', 'targetName', 'version', 'label', 'startedAt', 'finishedAt', 'status', 'metric',
            'error', 'imported', 'model', 'judgeLater', 'repeats')
    return {k: run.get(k) for k in keys}


@app.get('/')
def index():
    """The Lab's interface is the Agent Lab section of Raindrop Workshop."""
    return RedirectResponse(workshop.URL + '/lab')


@app.get('/api/state')
def state():
    analysis = store.load('discover.json')
    if analysis:
        analysis['summary'] = discover.summarize(analysis['results'], analysis['topics'])
    deck = store.load('cards.json')
    return {
        'job': job,
        'model': llm.model_label,
        'workshop': {'url': workshop.URL, 'available': workshop.available()},
        'logs': {'total': len(discover.logs()) if (store.DATA / 'logs.jsonl').exists() else 0},
        'discover': analysis,
        'cards': deck,
        'runs': [_run_summary(r) for r in store.runs()],
        'targets': [targets.public(k, v) for k, v in targets.configs().items()],
    }


@app.get('/api/runs/{run_id}')
def run_detail(run_id: str):
    run = next((r for r in store.runs() if r['id'] == run_id), None)
    if not run:
        raise HTTPException(404, 'Прогон не найден')
    return run


@app.post('/api/discover')
async def start_discover(payload: dict = Body(default={})):
    count = max(5, min(int(payload.get('count') or 60), 300))
    replan = bool(payload.get('replan'))
    return _start('discover', lambda progress: discover.run(count, progress, replan))


@app.post('/api/cards')
async def start_cards():
    return _start('cards', lambda progress: cards.run(progress))


@app.post('/api/runs')
async def start_run(payload: dict = Body(...)):
    target = str(payload.get('target') or '')
    if target not in targets.configs():
        raise HTTPException(400, 'Неизвестный агент')
    ids = payload.get('cardIds') or None
    repeats = max(1, min(int(payload.get('repeats') or 1), 3))
    return _start('run', lambda progress: simulate.run(target, ids, str(payload.get('label') or ''), progress,
                                                        repeats=repeats))


@app.post('/api/review')
async def review(payload: dict = Body(...)):
    """A person agrees or disagrees with the judge's verdict on one conversation."""
    run_id, index, decision = str(payload.get('run') or ''), payload.get('index'), payload.get('decision')
    if decision not in ('agree', 'disagree', None):
        raise HTTPException(400, 'decision: agree | disagree | null')
    record = next((r for r in store.runs() if r['id'] == run_id), None)
    if not record or not isinstance(index, int) or not 0 <= index < len(record['items']):
        raise HTTPException(404, 'Разговор не найден')
    record['items'][index]['review'] = decision
    record['metric'] = simulate.metric(record['items'])
    store.save(f"runs/{run_id}.json", record)
    return {'ok': True, 'metric': record['metric']}


@app.post('/api/import')
async def import_run(payload: dict = Body(...)):
    if not isinstance(payload.get('items'), list) or not payload.get('id'):
        raise HTTPException(400, 'Это не файл прогона Agent Lab')
    if job['running']:
        raise HTTPException(409, 'Уже выполняется: ' + str(job['kind']))
    _start('import', lambda progress: simulate.import_run(payload, progress))
    return {'id': payload['id']}
