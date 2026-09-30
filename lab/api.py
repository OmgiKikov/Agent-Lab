"""HTTP API of the Agent Lab section in Workshop (workshop/app/src/pages/LabPage.tsx).

Long work (sources, audit, cards, a run, a rejudge) runs as one background job at a time; the page polls /api/state.
"""

import asyncio
import uuid
from collections.abc import Awaitable, Callable

from fastapi import Body, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse

from . import agents, cards, discover, llm, logs, personas, problems, simulate, store, workshop
from .context import sources
from .metric import metric

app = FastAPI(title='Agent Lab')
# The UI is served by Workshop (5899), or by Vite (5900) while it is being developed.
app.add_middleware(
    CORSMiddleware,
    allow_origins=['http://127.0.0.1:5899', 'http://localhost:5899', 'http://127.0.0.1:5900', 'http://localhost:5900'],
    allow_methods=['GET', 'POST'],
    allow_headers=['Content-Type'],
)
job: dict = {'kind': None, 'running': False, 'error': None, 'progress': {}}
STOPPED = 'Остановлено'
_task: asyncio.Task | None = None
RUN_FIELDS = (
    'id', 'target', 'targetName', 'version', 'label', 'startedAt', 'finishedAt', 'status', 'metric', 'error',
    'model', 'repeats', 'personas',
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
        'logs': {'total': len(logs.load()), **logs.meta()},
        'discover': analysis,
        'cards': store.load(cards.DECK),
        'runs': [{k: r.get(k) for k in RUN_FIELDS} for r in store.runs()],
        'targets': [agents.public(key, config) for key, config in agents.configs().items()],
        'personas': personas.public(),
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
    chosen = [str(p) for p in payload.get('personas') or [] if str(p) in personas.PERSONAS] or [personas.DEFAULT]
    return start(
        'run', lambda progress: simulate.run(key, payload.get('cardIds') or None, label, progress, repeats, chosen)
    )


@app.post('/api/runs/{run_id}/rejudge')
async def rejudge(run_id: str) -> dict:
    """Judge the run's conversations again with the current judges; the agent is not called."""
    record = store.run(run_id)
    if not record:
        raise HTTPException(404, 'Прогон не найден')
    return start('rejudge', lambda progress: simulate.rejudge(record, progress))


@app.get('/api/problems')
def problems_view(run: str | None = None) -> dict:
    """Every rule with its verdicts in the logs and in one run; the rules found violated are the problems."""
    if run and not store.run(run):
        raise HTTPException(404, 'Прогон не найден')
    return problems.build(run)


@app.get('/api/dialogues/{dialogue_id}')
def dialogue_view(dialogue_id: str) -> dict:
    """A logged conversation in full, with its verdicts from the last assessment."""
    found = next((d for d in logs.load() if str(d['id']) == dialogue_id), None)
    if not found:
        raise HTTPException(404, 'Диалог не найден в логах')
    analysis = store.load(discover.RESULT) or {}
    topics = {t['id']: t['title'] for t in analysis.get('topics') or []}
    result = next((r for r in analysis.get('results') or [] if str(r['dialogueId']) == dialogue_id), None)
    messages = [
        {'role': 'customer' if m['role'] == 'user' else 'agent', 'text': m['content']} for m in found['messages']
    ]
    return {
        'id': dialogue_id,
        'messages': messages,
        'result': result and {**result, 'topic': topics.get(result['topicId'], '')},
    }


@app.get('/api/sources/{source_id}')
def source_view(source_id: str) -> dict:
    """The text of a source the rules are quoted from: a prompt or the list of the agent's tools."""
    found = next((s for s in sources.load() if s['id'] == source_id), None)
    if not found:
        raise HTTPException(404, 'Источник не найден')
    return {key: found.get(key) for key in ('id', 'kind', 'origin', 'sha256', 'content')}


def review_log(dialogue_id: str, rule_id: str, decision: str | None) -> dict:
    if job['running'] and job['kind'] == 'discover':
        raise HTTPException(409, 'Идёт оценка логов: решение не сохранится. Отметьте после неё.')
    analysis = store.load(discover.RESULT) or {}
    result = next((r for r in analysis.get('results') or [] if str(r['dialogueId']) == dialogue_id), None)
    row = next((r for r in (result or {}).get('rules') or [] if r['ruleId'] == rule_id), None)
    if not row:
        raise HTTPException(404, 'Вердикт не найден')
    row['review'] = decision
    store.save(discover.RESULT, analysis)
    return {'ok': True}


@app.post('/api/review')
async def review(payload: dict = Body(...)) -> dict:
    """A person agrees or disagrees with the judge: on one rule of a logged or simulated conversation, or (older
    requests without ruleId) on a simulated conversation as a whole."""
    decision = payload.get('decision')
    if decision not in ('agree', 'disagree', None):
        raise HTTPException(400, 'decision: agree | disagree | null')
    rule_id = str(payload.get('ruleId') or '')
    if payload.get('source') == 'log':
        return review_log(str(payload.get('dialogueId') or ''), rule_id, decision)
    run_id, index = str(payload.get('run') or ''), payload.get('index')
    record = store.run(run_id)
    if not record or not isinstance(index, int) or not 0 <= index < len(record['items']):
        raise HTTPException(404, 'Разговор не найден')
    if record.get('status') == 'running':
        raise HTTPException(409, 'Прогон ещё идёт: решение не сохранится. Отметьте после него.')
    item = record['items'][index]
    if rule_id:
        row = next((r for r in item.get('rules') or [] if r['ruleId'] == rule_id), None)
        if not row:
            raise HTTPException(404, 'Вердикт не найден')
        row['review'] = decision
    else:
        item['review'] = decision
    record['metric'] = metric(record['items'])
    store.save_run(record)
    return {'ok': True, 'metric': record['metric']}
