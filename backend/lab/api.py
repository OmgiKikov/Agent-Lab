"""Agent Lab HTTP commands. Long work has one owner; computation precedes persistence."""

import asyncio
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Literal

from fastapi import Body, FastAPI, HTTPException, Request
from pydantic import BaseModel, Field

from . import agents, cards, discover, llm, logs, personas, problems, simulate, store
from .context import sources
from .jobs import BusyError, Jobs, Progress, Work

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
    """A person's decision on what the judge found: on one criterion of a logged or simulated conversation, or (older
    requests without ruleId) on a simulated conversation as a whole."""

    source: Literal['log', 'sim'] = 'sim'
    run: str = ''
    index: int | None = Field(default=None, ge=0, strict=True)
    dialogueId: str = ''
    ruleId: str = ''
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
            'sha256': source.get('sha256'),
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
        'model': llm.MODEL,
        'models': llm.describe(),
        'settings': agents.settings(),
        'sources': source_summary(),
        'logs': {'total': len(logs.load()), **logs.meta()},
        'discover': analysis,
        'cards': store.load(cards.DECK),
        'runs': [{key: record.get(key) for key in RUN_FIELDS} for record in store.runs()],
        'targets': [agents.public(key, config) for key, config in agents.configs().items()],
        'personas': personas.public(),
    }


@app.post('/api/settings')
async def save_settings(payload: SettingsCommand) -> dict:
    if jobs.state['running']:
        raise HTTPException(409, f'Настройки нельзя менять, пока выполняется: {jobs.state["kind"]}')
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
        async with agents.session(agent):
            reply = await agent.say(str(uuid.uuid4()), CHECK_QUESTION)
        return {'ok': True, 'question': CHECK_QUESTION, 'version': agent.version, **reply}
    except agents.AgentError as error:
        return {'ok': False, 'error': str(error)}


@app.post('/api/models/check')
async def check_models() -> dict:
    main, second = await asyncio.gather(llm.check(llm.MAIN), llm.check(llm.SECOND))
    return {'main': main, 'second': second}


@app.post('/api/sources')
async def collect_sources() -> dict:
    async def work(progress: Progress) -> list[dict]:
        collected = await asyncio.to_thread(sources.collect, agents.repo())
        store.replace_inputs(sources.FILE, collected)
        return collected

    return start('sources', work)


@app.post('/api/logs')
async def upload_logs(request: Request, name: str) -> dict:
    async def work(progress: Progress) -> int:
        dialogues = await asyncio.to_thread(logs.prepare, name, await request.body())
        return logs.commit(dialogues, name)

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


@app.get('/api/problems')
def problems_view(run: str | None = None) -> dict:
    """Every rule with its verdicts in the logs and in one run; the rules found violated are the problems."""
    if run and store.run(run) is None:
        raise HTTPException(404, 'Прогон не найден')
    return problems.build(run)


@app.get('/api/sources/{source_id}')
def source_view(source_id: str) -> dict:
    """The text of a source the rules are quoted from: a prompt or the list of the agent's tools."""
    found = next((source for source in sources.load() if source['id'] == source_id), None)
    if found is None:
        raise HTTPException(404, 'Источник не найден')
    return {key: found.get(key) for key in ('id', 'kind', 'origin', 'sha256', 'content')}


@app.get('/api/runs/{run_id}')
def run_detail(run_id: str) -> dict:
    record = store.run(run_id)
    if record is None:
        raise HTTPException(404, 'Прогон не найден')
    return record


@app.post('/api/discover')
async def start_discover(payload: DiscoverCommand | None = Body(default=None)) -> dict:
    payload = payload or DiscoverCommand()

    async def work(progress: Progress) -> dict:
        result = await discover.run(payload.count, progress, payload.replan)
        store.save(discover.RESULT, result)
        return result

    return start('discover', work)


@app.post('/api/cards')
async def start_cards() -> dict:
    async def work(progress: Progress) -> list[dict]:
        deck = await cards.run(progress)
        store.save(cards.DECK, {'createdAt': store.now(), 'model': llm.models_used(deck), 'cards': deck})
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
    if payload.source == 'log':
        if not payload.dialogueId or not payload.ruleId:
            raise HTTPException(422, 'Нужны dialogueId и ruleId')
        if jobs.state['running'] and jobs.state['kind'] == 'discover':
            raise HTTPException(409, 'Идёт оценка логов: ответ не сохранится. Отметьте после неё.')
        try:
            store.set_log_review(discover.RESULT, payload.dialogueId, payload.ruleId, payload.decision)
        except KeyError as error:
            raise HTTPException(404, 'Вердикт не найден') from error
        return {'ok': True}
    if payload.index is None:
        raise HTTPException(422, 'Нужны run и index')
    try:
        record = store.set_review(payload.run, payload.index, payload.decision, payload.ruleId or None)
    except (KeyError, IndexError) as error:
        raise HTTPException(404, 'Разговор не найден') from error
    return {'ok': True, 'metric': record['metric']}
