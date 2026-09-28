"""HTTP API of the Agent Lab section in Workshop (workshop/app/src/pages/LabPage.tsx).

Long work (sources, audit, cards, a run, a rejudge) runs as one background job at a time; the page polls /api/state.
"""

import asyncio
import uuid
from collections.abc import Awaitable, Callable

from fastapi import Body, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse

from . import agents, cards, discover, llm, logs, simulate, store, workshop
from .context import sources
from .metric import metric

app = FastAPI(title='Agent Lab')
# The section is served by Workshop, another local origin.
app.add_middleware(
    CORSMiddleware,
    allow_origins=['http://127.0.0.1:5899', 'http://localhost:5899'],
    allow_methods=['GET', 'POST'],
    allow_headers=['Content-Type'],
)
job: dict = {'kind': None, 'running': False, 'error': None, 'progress': {}}
STOPPED = 'Остановлено'
_task: asyncio.Task | None = None
RUN_FIELDS = (
    'id', 'target', 'targetName', 'version', 'label', 'startedAt', 'finishedAt', 'status', 'metric', 'error',
    'model', 'repeats',
)  # fmt: skip
CHECK_QUESTION = 'Какой процент эквайринга?'


def start(kind: str, work: Callable[[Callable[..., None]], Awaitable[object]]) -> dict:
    global _task
    if job['running']:
        raise HTTPException(409, f'Уже выполняется: {job["kind"]}')
    job.update(kind=kind, running=True, error=None, progress={'message': 'Запускаю…'})

    def progress(**values) -> None:
        job['progress'] = values

    async def body() -> None:
        try:
            await work(progress)
        except asyncio.CancelledError:
            job['error'] = STOPPED
        except Exception as error:  # shown on the page, never swallowed
            job['error'] = str(error) or type(error).__name__
        finally:
            job['running'] = False

    _task = asyncio.get_running_loop().create_task(body())
    return {'ok': True}


@app.post('/api/job/stop')
async def stop_job() -> dict:
    """Stop the running job. What it had finished stays; an unfinished audit or card set is not saved."""
    if not job['running'] or _task is None:
        raise HTTPException(409, 'Сейчас ничего не выполняется')
    _task.cancel()
    return {'ok': True}


def source_summary() -> list[dict]:
    """The collected sources with how many audit rules each one grounds."""
    rules = {s['id']: s.get('rules', 0) for s in (store.load(discover.RESULT) or {}).get('sources') or []}
    return [
        {
            'id': s['id'],
            'kind': s['kind'],
            'origin': s['origin'],
            'chars': len(s['content']),
            'rules': rules.get(s['id'], 0),
        }
        for s in sources.load()
    ]


@app.get('/')
def index() -> RedirectResponse:
    return RedirectResponse(f'{workshop.URL}/lab')


@app.get('/api/state')
def state() -> dict:
    analysis = store.load(discover.RESULT)
    if analysis:
        analysis['summary'] = discover.summarize(analysis['results'], analysis['topics'])
    return {
        'job': job,
        'model': llm.model_label,
        'models': llm.describe(),
        'workshop': {'url': workshop.URL, 'available': workshop.available()},
        'settings': agents.settings(),
        'sources': source_summary(),
        'logs': {'total': len(logs.load())},
        'discover': analysis,
        'cards': store.load(cards.DECK),
        'runs': [{k: r.get(k) for k in RUN_FIELDS} for r in store.runs()],
        'targets': [agents.public(key, config) for key, config in agents.configs().items()],
    }


@app.post('/api/settings')
def save_settings(payload: dict = Body(...)) -> dict:
    return agents.save_settings(payload)


@app.post('/api/agents/{key}/check')
async def check_agent(key: str) -> dict:
    """One question to the agent: is it reachable, and what does the Lab read from its answer."""
    if key not in agents.configs():
        raise HTTPException(404, 'Неизвестный агент')
    agent = agents.create(key)
    if isinstance(agent, agents.CodeAgent):
        raise HTTPException(400, 'Агент из исходников запускается только на время прогона')
    try:
        await agent.open()
        reply = await agent.say(str(uuid.uuid4()), CHECK_QUESTION)
    except agents.AgentError as error:
        return {'ok': False, 'error': str(error)}
    return {'ok': True, 'question': CHECK_QUESTION, 'version': agent.version, **reply}


@app.post('/api/models/check')
async def check_models() -> dict:
    main, second = await asyncio.gather(llm.check(llm.MAIN), llm.check(llm.SECOND))
    return {'main': main, 'second': second}


@app.post('/api/sources')
async def collect_sources() -> dict:
    return start('sources', lambda progress: asyncio.to_thread(sources.build, agents.repo()))


@app.post('/api/logs')
async def upload_logs(request: Request, name: str) -> dict:
    """The chat's Excel export (or prepared .jsonl) as the request body."""
    if job['running']:
        raise HTTPException(409, f'Уже выполняется: {job["kind"]}')
    try:
        count = await asyncio.to_thread(logs.replace, name, await request.body())
    except (ValueError, KeyError, OSError) as error:
        raise HTTPException(400, f'Не удалось прочитать файл: {error}') from error
    return {'total': count}


@app.get('/api/runs/{run_id}')
def run_detail(run_id: str) -> dict:
    record = store.run(run_id)
    if not record:
        raise HTTPException(404, 'Прогон не найден')
    return record


@app.post('/api/discover')
async def start_discover(payload: dict = Body(default={})) -> dict:
    count = max(5, min(int(payload.get('count') or 60), 300))
    replan = bool(payload.get('replan'))
    return start('discover', lambda progress: discover.run(count, progress, replan))


@app.post('/api/cards')
async def start_cards() -> dict:
    return start('cards', cards.run)


@app.post('/api/runs')
async def start_run(payload: dict = Body(...)) -> dict:
    key = str(payload.get('target') or '')
    if key not in agents.configs():
        raise HTTPException(400, 'Неизвестный агент')
    label = str(payload.get('label') or '')
    repeats = max(1, min(int(payload.get('repeats') or 1), 3))
    return start('run', lambda progress: simulate.run(key, payload.get('cardIds') or None, label, progress, repeats))


@app.post('/api/runs/{run_id}/rejudge')
async def rejudge(run_id: str) -> dict:
    """Judge the run's conversations again with the current judges; the agent is not called."""
    record = store.run(run_id)
    if not record:
        raise HTTPException(404, 'Прогон не найден')
    return start('rejudge', lambda progress: simulate.rejudge(record, progress))


@app.post('/api/review')
async def review(payload: dict = Body(...)) -> dict:
    """A person agrees or disagrees with the judge's verdict on one conversation."""
    run_id, index, decision = str(payload.get('run') or ''), payload.get('index'), payload.get('decision')
    if decision not in ('agree', 'disagree', None):
        raise HTTPException(400, 'decision: agree | disagree | null')
    record = store.run(run_id)
    if not record or not isinstance(index, int) or not 0 <= index < len(record['items']):
        raise HTTPException(404, 'Разговор не найден')
    record['items'][index]['review'] = decision
    record['metric'] = metric(record['items'])
    store.save_run(record)
    return {'ok': True, 'metric': record['metric']}
