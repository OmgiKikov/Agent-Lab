"""Agent Lab HTTP commands. Long work has one owner; computation precedes persistence."""

import asyncio
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Literal

from fastapi import Body, FastAPI, HTTPException, Request
from pydantic import BaseModel, Field

from . import agents, cards, discover, llm, logs, personas, simulate, store
from .context import sources
from .jobs import BusyError, Jobs, Work

jobs = Jobs()


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    store.recover_runs()
    try:
        yield
    finally:
        await jobs.close()


app = FastAPI(title='Agent Lab', lifespan=lifespan)
RUN_FIELDS = (
    'id', 'target', 'targetName', 'version', 'label', 'startedAt', 'finishedAt', 'status', 'metric', 'error',
    'model', 'repeats', 'personas', 'updatedAt', 'revision',
)  # fmt: skip
CHECK_QUESTION = 'Какой процент эквайринга?'


class DiscoverCommand(BaseModel):
    count: int = Field(default=60, ge=5, le=300)
    replan: bool = False


class SettingsCommand(BaseModel):
    prodUrl: str = ''
    epk: list[str] | str = Field(default_factory=list)
    repo: str = ''


class RunCommand(BaseModel):
    target: str
    label: str = ''
    repeats: int = Field(default=1, ge=1, le=3)
    personas: list[str] = Field(default_factory=list)
    cardIds: list[str] | None = None


class ReviewCommand(BaseModel):
    run: str
    index: int = Field(ge=0, strict=True)
    decision: Literal['agree', 'disagree'] | None = None


def start(kind: str, work: Work) -> dict:
    try:
        return jobs.start(kind, work)
    except BusyError as error:
        raise HTTPException(409, str(error)) from error


@app.post('/api/job/stop')
async def stop_job() -> dict:
    try:
        await jobs.stop()
    except BusyError as error:
        raise HTTPException(409, str(error)) from error
    return {'ok': True}


def source_summary() -> list[dict]:
    rules = {
        source['id']: source.get('rules', 0) for source in (store.load(discover.RESULT) or {}).get('sources') or []
    }
    return [
        {
            'id': source['id'],
            'kind': source['kind'],
            'origin': source['origin'],
            'chars': len(source['content']),
            'rules': rules.get(source['id'], 0),
        }
        for source in sources.load()
    ]


@app.get('/api/state')
def state() -> dict:
    analysis = store.load(discover.RESULT)
    if analysis:
        analysis['summary'] = discover.summarize(analysis['results'], analysis['topics'])
    return {
        'job': jobs.state,
        'model': llm.model_label,
        'models': llm.describe(),
        'settings': agents.settings(),
        'sources': source_summary(),
        'logs': {'total': len(logs.load())},
        'discover': analysis,
        'cards': store.load(cards.DECK),
        'runs': [{key: record.get(key) for key in RUN_FIELDS} for record in store.runs()],
        'targets': [agents.public(key, config) for key, config in agents.configs().items()],
        'personas': personas.public(),
    }


@app.post('/api/settings')
def save_settings(payload: SettingsCommand) -> dict:
    try:
        return agents.save_settings(payload.model_dump(exclude_unset=True))
    except ValueError as error:
        raise HTTPException(400, str(error)) from error


@app.post('/api/agents/{key}/check')
async def check_agent(key: str) -> dict:
    if key not in agents.configs():
        raise HTTPException(404, 'Неизвестный агент')
    agent = agents.create(key)
    if isinstance(agent, agents.CodeAgent):
        raise HTTPException(400, 'Агент из исходников запускается только на время прогона')
    try:
        await agent.open()
        reply = await agent.say(str(uuid.uuid4()), CHECK_QUESTION)
        return {'ok': True, 'question': CHECK_QUESTION, 'version': agent.version, **reply}
    except agents.AgentError as error:
        return {'ok': False, 'error': str(error)}
    finally:
        await agent.close()


@app.post('/api/models/check')
async def check_models() -> dict:
    main, second = await asyncio.gather(llm.check(llm.MAIN), llm.check(llm.SECOND))
    return {'main': main, 'second': second}


@app.post('/api/sources')
async def collect_sources() -> dict:
    async def work(progress) -> list[dict]:
        collected = await asyncio.to_thread(sources.collect, agents.repo())
        store.replace_inputs(sources.FILE, collected)
        return collected

    return start('sources', work)


@app.post('/api/logs')
async def upload_logs(request: Request, name: str) -> dict:
    async def work(progress) -> int:
        dialogues = await asyncio.to_thread(logs.prepare, name, await request.body())
        return logs.commit(dialogues)

    try:
        count = await jobs.perform('logs', work)
    except BusyError as error:
        raise HTTPException(409, str(error)) from error
    except asyncio.CancelledError as error:
        raise HTTPException(409, 'Загрузка остановлена') from error
    except (ValueError, KeyError, OSError) as error:
        raise HTTPException(400, f'Не удалось прочитать файл: {error}') from error
    return {'total': count}


@app.get('/api/logs/{dialogue_id}')
def log_detail(dialogue_id: str) -> dict:
    dialogue = logs.read(dialogue_id)
    if dialogue is None:
        raise HTTPException(404, 'Разговор не найден')
    analysis = store.load(discover.RESULT) or {}
    evaluation = next(
        (result for result in analysis.get('results', []) if str(result['dialogueId']) == dialogue_id), None
    )
    return {**dialogue, 'evaluation': evaluation}


@app.get('/api/runs/{run_id}')
def run_detail(run_id: str) -> dict:
    record = store.run(run_id)
    if record is None:
        raise HTTPException(404, 'Прогон не найден')
    return record


@app.post('/api/discover')
async def start_discover(payload: DiscoverCommand | None = Body(default=None)) -> dict:
    payload = payload or DiscoverCommand()

    async def work(progress) -> dict:
        result = await discover.run(payload.count, progress, payload.replan)
        store.save(discover.RESULT, result)
        return result

    return start('discover', work)


@app.post('/api/cards')
async def start_cards() -> dict:
    async def work(progress) -> list[dict]:
        deck = await cards.run(progress)
        store.save(cards.DECK, {'createdAt': store.now(), 'model': llm.model_label, 'cards': deck})
        return deck

    return start('cards', work)


@app.post('/api/runs')
async def start_run(payload: RunCommand) -> dict:
    if payload.target not in agents.configs():
        raise HTTPException(400, 'Неизвестный агент')
    chosen = [key for key in payload.personas if key in personas.PERSONAS] or [personas.DEFAULT]
    return start(
        'run',
        lambda progress: simulate.run(
            payload.target, payload.cardIds or None, payload.label, progress, payload.repeats, chosen
        ),
    )


@app.post('/api/runs/{run_id}/rejudge')
async def rejudge(run_id: str) -> dict:
    record = store.run(run_id)
    if record is None:
        raise HTTPException(404, 'Прогон не найден')
    return start('rejudge', lambda progress: simulate.rejudge(record, progress))


@app.post('/api/review')
async def review(payload: ReviewCommand) -> dict:
    try:
        record = store.set_review(payload.run, payload.index, payload.decision)
    except (KeyError, IndexError) as error:
        raise HTTPException(404, 'Разговор не найден') from error
    return {'ok': True, 'metric': record['metric']}
