"""Agent Lab HTTP commands. Long work has one owner; computation precedes persistence."""

import asyncio
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from typing import Literal

from fastapi import Body, FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field

from . import (
    accuracy_history,
    agents,
    cards,
    checks,
    compare,
    discover,
    llm,
    logs,
    personas,
    policy_files,
    problems,
    registry,
    scenarios,
    simulate,
    store,
    tone,
    tone_advice,
)
from .context import knowledge, sources
from .jobs import BusyError, PerAgent, Progress, Work

jobs = PerAgent()


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    registry.adopt_legacy()
    agents = registry.listed()
    if not agents and store.DB.exists():
        store.recover_runs()  # before any agent: the default database, never created here
    for agent in agents:
        with registry.using(agent['id']):
            store.recover_runs()
    try:
        yield
    finally:
        await jobs.close()


app = FastAPI(title='Agent Lab', lifespan=lifespan)


@app.middleware('http')
async def agent_of_request(request: Request, call_next: Callable[[Request], Awaitable[Response]]) -> Response:
    """A product request works inside one agent: the X-Agent header, or the first agent. Its jobs keep that agent."""
    path = request.url.path
    if not path.startswith('/api/') or path == '/api/agents':  # the list of agents is above any agent
        return await call_next(request)
    agent_id = request.headers.get('x-agent') or registry.default_id()
    if agent_id is None:
        return await call_next(request)
    if registry.get(agent_id) is None:
        return JSONResponse({'detail': 'Агент не найден'}, status_code=404)
    token = store.AGENT.set(registry.db_of(agent_id))
    try:
        return await call_next(request)
    finally:
        store.AGENT.reset(token)


RUN_FIELDS = (
    'id', 'target', 'targetName', 'version', 'label', 'startedAt', 'finishedAt', 'status', 'metric', 'error',
    'model', 'repeats', 'personas', 'updatedAt', 'revision', 'check',
)  # fmt: skip
CHECK_QUESTION = 'Какой процент эквайринга?'
# The job that writes a check's result: while it runs, answers on that result would be lost (review).
WRITES = {'tone-check': checks.TONE, 'discover': checks.CODE}
NOT_CHECKED = 'Этот критерий в разговоре не проверялся.'  # an answer on a logged conversation without this verdict


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


class TonePolicyCommand(BaseModel):
    text: str = Field(min_length=20, max_length=50000)
    name: str = Field(default='Правила tone of voice', min_length=1, max_length=160)


class ToneCopyCommand(BaseModel):
    agent: str = Field(min_length=1, max_length=120)


class ToneCheckCommand(BaseModel):
    ruleIds: list[str] = Field(min_length=1, max_length=20)
    count: int = Field(default=300, ge=1, le=300)
    revision: str | None = None


class ToneAdviceCommand(BaseModel):
    finishedAt: str = Field(min_length=1)
    dialogueId: str = Field(min_length=1)
    ruleId: str = Field(min_length=1)
    mode: Literal['rewrite', 'clarify']
    note: str = Field(default='', max_length=2000)


class ToneClarificationCommand(BaseModel):
    revision: str = Field(min_length=1)
    ruleId: str = Field(min_length=1)
    text: str = Field(min_length=10, max_length=2000)


class ReviewCommand(BaseModel):
    """A person's decision on what the judge found: on one criterion of a logged or simulated conversation, or (older
    requests without ruleId) on a simulated conversation as a whole. On a logged one, check names the check whose
    result it goes to. finishedAt (the check's result) and status (the verdict) are what the person saw: when either
    changed meanwhile, the decision is refused."""

    source: Literal['log', 'sim'] = 'sim'
    check: Literal['tone', 'code'] | None = None
    run: str = ''
    index: int | None = Field(default=None, ge=0, strict=True)
    dialogueId: str = ''
    ruleId: str = ''
    decision: Literal['agree', 'disagree'] | None = None
    finishedAt: str | None = None
    status: str | None = None


class CardsCommand(BaseModel):
    check: Literal['tone', 'code'] | None = None


def start(kind: str, work: Work) -> dict:
    try:
        return jobs.start(kind, work)
    except BusyError as error:
        raise HTTPException(409, str(error)) from error


class AgentCommand(BaseModel):
    name: str = Field(max_length=80)
    description: str = Field(default='', max_length=200)


def result_line(check: str) -> dict | None:
    """The current agent's result of one check in one line: errors of measured, not checked, when."""
    value = store.load(checks.result(check)) or {}
    summary = value.get('summary') or {}
    if not value.get('finishedAt') or any(key not in summary for key in ('failed', 'measured', 'unmeasured')):
        return None  # nothing finished, or a record of another shape: never a reason to hide the other agents
    return {key: summary[key] for key in ('failed', 'measured', 'unmeasured')} | {'finishedAt': value['finishedAt']}


def rules_line() -> dict | None:
    """The current agent's rules of communication in a line, for taking them into another agent: their name, how many
    criteria were collected from them (0 before that), and their hash, which says whether two agents' rules are the
    same. None without rules."""
    found = tone.rules()
    if found is None:
        return None
    policy, draft = found
    return {
        'name': policy.get('name') or policy.get('origin') or '',
        'criteria': len(draft['criteria']) if draft else 0,
        'sha256': policy.get('sha256'),
    }


@app.get('/api/agents')
def agents_view() -> list[dict]:
    """Every agent with the result of each of its checks and its rules of communication, read from its own database.
    Never ranked: the agents have other dialogues and other rules; nor are an agent's two checks added up."""
    listed = []
    for agent in registry.listed():
        with registry.using(agent['id']):
            results = {check: result_line(check) for check in checks.RESULTS}
            listed.append({**agent, 'results': results, 'rules': rules_line()})
    return listed


@app.post('/api/agents')
def create_agent(payload: AgentCommand) -> dict:
    try:
        return registry.create(payload.name, payload.description)
    except ValueError as error:
        raise HTTPException(400, str(error)) from error


@app.post('/api/job/stop')
async def stop_job() -> dict:
    try:
        await jobs.stop()
    except BusyError as error:
        raise HTTPException(409, str(error)) from error
    return {'ok': True}


def source_summary(analysis: dict | None) -> list[dict]:
    rules = {source['id']: source.get('rules', 0) for source in (analysis or {}).get('sources') or []}
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
    """Polled every 1.5 s during a job: each check's result is read once; runs and dialogues are not parsed at all."""
    results = {check: store.load(checks.result(check)) for check in checks.RESULTS}
    for result in results.values():
        if result and not result.get('summary'):  # every result stores its summary; an older one may not
            result['summary'] = discover.summarize(result['results'], result['topics'])
    return {
        'job': jobs.state,
        'model': llm.MODEL,
        'models': llm.describe(),
        'settings': agents.settings(),
        'sources': source_summary(results[checks.CODE]),
        'logs': {'total': store.length(logs.FILE), **logs.meta()},
        'checks': results,
        'toneOfVoice': store.load(tone.DRAFT),
        'cards': store.load(cards.DECK),
        'runs': [{key: summary.get(key) for key in RUN_FIELDS} for summary in store.run_summaries()],
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
    endpoint = llm.second_judge()
    if endpoint is None:
        return {'main': await llm.check(llm.MAIN), 'second': None}
    main, second = await asyncio.gather(llm.check(llm.MAIN), llm.check(endpoint))
    return {'main': main, 'second': second}


@app.post('/api/sources')
async def collect_sources() -> dict:
    async def work(progress: Progress) -> list[dict]:
        collected = await asyncio.to_thread(sources.collect, agents.repo())
        # The tone-of-voice policy is a person's document, not the agent's code: re-reading the code keeps it.
        policy = [source for source in sources.load() if source['kind'] == tone.KIND]
        store.replace_inputs(sources.FILE, [*collected, *policy])
        return collected

    return start('sources', work)


async def uploaded(request: Request, limit: int) -> bytes:
    """The uploaded file: refused by its declared length before a byte is read, and never read past the limit."""
    message = f'Файл слишком большой: не более {limit / 1_000_000:g} МБ.'
    try:
        declared = int(request.headers.get('content-length') or 0)
    except ValueError:
        declared = 0  # counted while reading
    if declared > limit:
        raise HTTPException(413, message)
    data = bytearray()
    async for chunk in request.stream():
        data += chunk
        if len(data) > limit:
            raise HTTPException(413, message)
    return bytes(data)


@app.post('/api/logs')
async def upload_logs(request: Request, name: str) -> dict:
    data = await uploaded(request, logs.LIMIT)

    async def work(progress: Progress) -> int:
        dialogues = await asyncio.to_thread(logs.prepare, name, data)
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
def log_detail(dialogue_id: str, check: Literal['tone', 'code'] | None = None) -> dict:
    """A logged conversation with its evaluation in the result of the check asked for; without one, in tone of voice's
    result, then in Точность's."""
    dialogue = logs.read(dialogue_id)
    if dialogue is None:
        raise HTTPException(404, 'Разговор не найден')
    evaluation = None
    for key in [check] if check else checks.RESULTS:
        analysis = store.load(checks.result(key)) or {}
        evaluation = next(
            (result for result in analysis.get('results', []) if str(result['dialogueId']) == dialogue_id), None
        )
        if evaluation:
            break
    return {**dialogue, 'evaluation': evaluation}


@app.get('/api/problems')
def problems_view(check: Literal['tone', 'code'] = checks.TONE, run: str | None = None) -> dict:
    """Every rule of one check with its verdicts in the logs and in one run of that check; the rules found violated
    are the problems. A run is measured by its own check's criteria, so its check is taken; without either, tone of
    voice (older links)."""
    if run:
        record = store.run(run)
        if record is None:
            raise HTTPException(404, 'Прогон не найден')
        check = checks.of_run(record)
    return problems.build(check, run)


@app.get('/api/compare')
def compare_view(check: Literal['tone', 'code'] = checks.TONE) -> dict:
    """«Было → стало»: the check's current result against its previous saved check, criterion by criterion, when both
    have the same criteria and models; otherwise only how they stand to each other. Reads saved records only."""
    return compare.build(check)


@app.get('/api/history/{check}')
def history_view(check: Literal['tone', 'code']) -> dict:
    """The saved checks of one check, the newest first, each with how it stands to the one saved before it."""
    return {'checks': compare.saved_checks(check)}


@app.get('/api/history/{check}/{check_id}')
def history_detail(check: Literal['tone', 'code'], check_id: str) -> dict:
    """A saved check with its evidence and the answers given on it: tone of voice's as /api/tone-of-voice/history/{id};
    Точность's with its result and the conversations it judged."""
    if check == checks.TONE:
        return tone_history_detail(check_id)
    return with_reviews(store.code_check(check_id), store.code_reviews(check_id))


@app.get('/api/scenarios')
def scenarios_view() -> dict:
    """Each scenario of the deck as a test: the error of the real conversation it reproduces, and its own result in
    every run of the deck's check, newest first. Results of runs stand side by side; nothing compares them."""
    return scenarios.build()


@app.get('/api/sources/{source_id}')
def source_view(source_id: str) -> dict:
    """The text of a source the rules are quoted from: a prompt or the list of the agent's tools."""
    found = next((source for source in sources.load() if source['id'] == source_id), None)
    if found is None:
        raise HTTPException(404, 'Источник не найден')
    return {key: found.get(key) for key in ('id', 'kind', 'origin', 'sha256', 'content')}


@app.get('/api/articles/{article_id}')
def article_view(article_id: str) -> dict:
    """A knowledge-base article the agent read during a simulated turn: its title and text."""
    found = knowledge.article(article_id)
    if found is None:
        raise HTTPException(404, 'Статьи нет в базе знаний агента')
    return found


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
        accuracy_history.commit(result, new_criteria=payload.replan)
        return result

    return start('discover', work)


@app.post('/api/cards')
async def start_cards(payload: CardsCommand | None = Body(default=None)) -> dict:
    """Scenarios from the errors of one check: the one asked for, else the only check with a result."""
    check = payload.check if payload else None
    if check is None:
        found = [key for key in checks.RESULTS if store.load(checks.result(key))]
        if len(found) > 1:
            raise HTTPException(400, 'Выберите, из какой проверки собрать сценарии')
        check = next(iter(found), None)

    async def work(progress: Progress) -> list[dict]:
        if check is None:
            raise RuntimeError('Сначала проверьте разговоры: сценарии собираются из найденных ошибок.')
        deck = await cards.run(check, progress)
        document = {'check': check, 'createdAt': store.now(), 'model': llm.models_used(deck), 'cards': deck}
        store.save(cards.DECK, document)
        return deck

    return start('cards', work)


@app.post('/api/tone-of-voice/policy')
async def save_tone_policy(payload: TonePolicyCommand) -> dict:
    async def work(progress: Progress) -> dict:
        source = tone.policy(payload.name.strip(), payload.text)
        kept = [item for item in sources.load() if item['kind'] != tone.KIND]
        store.replace_inputs(sources.FILE, [*kept, source])
        return {'ok': True}

    try:
        return await jobs.perform('tone-policy', work)
    except BusyError as error:
        raise HTTPException(409, str(error)) from error
    except ValueError as error:
        raise HTTPException(400, str(error)) from error


@app.post('/api/tone-of-voice/copy')
async def copy_tone_rules(payload: ToneCopyCommand) -> dict:
    """The rules of communication of another agent (`agent`) and their criteria, with the clarifications people
    confirmed, become this agent's own as a copy: later changes in either never reach the other (tone.take).
    `unchanged` when this agent has the same rules and criteria already: nothing is written then."""
    source = registry.get(payload.agent)
    if source is None:
        raise HTTPException(404, 'Агент не найден')
    if registry.db_of(source['id']) == store.database():
        raise HTTPException(400, 'Правила можно взять только у другого агента')
    with registry.using(source['id']):
        found = tone.rules()
    if found is None:
        raise HTTPException(400, f'У агента «{source["name"]}» нет правил общения')

    async def work(progress: Progress) -> dict:
        return {'ok': True, 'unchanged': not tone.take(*found)}

    try:
        return await jobs.perform('tone-policy', work)
    except BusyError as error:
        raise HTTPException(409, str(error)) from error


@app.post('/api/tone-of-voice/read-file')
async def read_tone_file(request: Request, name: str) -> dict:
    data = await uploaded(request, policy_files.LIMIT)
    try:
        text = await asyncio.to_thread(policy_files.read, name, data)
    except ValueError as error:
        raise HTTPException(400, str(error)) from error
    return {'text': text, 'name': name}


@app.post('/api/tone-of-voice/criteria')
async def prepare_tone_criteria() -> dict:
    async def work(progress: Progress) -> dict:
        draft = await tone.prepare(progress)
        store.save_tone_draft(draft)
        return draft

    return start('tone-criteria', work)


@app.post('/api/tone-of-voice/check')
async def check_tone(payload: ToneCheckCommand) -> dict:
    try:
        criteria = tone.selection(payload.ruleIds, payload.revision)
    except ValueError as error:
        raise HTTPException(400, str(error)) from error

    async def work(progress: Progress) -> dict:
        result = await tone.assess(criteria, payload.count, progress)
        tone.commit(result)
        return result

    return start('tone-check', work)


@app.get('/api/tone-of-voice/history')
def tone_history() -> dict:
    result = store.load(tone.RESULT) or {}
    return {
        'checks': store.tone_checks(),
        'hasLegacyResult': result.get('purpose') == tone.KIND and not result.get('checkId'),
    }


@app.get('/api/tone-of-voice/history/{check_id}')
def tone_history_detail(check_id: str) -> dict:
    return with_reviews(store.tone_check(check_id), store.tone_reviews(check_id))


def with_reviews(snapshot: dict | None, reviews: list[dict]) -> dict:
    """A saved check with the answers people gave on it since it finished, over the ones it was saved with."""
    if snapshot is None:
        raise HTTPException(404, 'Проверка не найдена')
    decisions = {(row['dialogueId'], row['ruleId']): row['decision'] for row in reviews}
    for result in snapshot['result']['results']:
        for row in result.get('rules', []):
            key = (str(result['dialogueId']), row['ruleId'])
            if key in decisions:
                row['review'] = decisions[key]
    snapshot.update(reviews=reviews, reviewSemantics='latest-saved')
    return snapshot


@app.post('/api/tone-of-voice/advice')
async def tone_advice_command(payload: ToneAdviceCommand) -> dict:
    async def work(progress: Progress) -> dict:
        progress(message='Готовлю предложение по найденной ошибке')
        return await tone_advice.suggest(
            payload.finishedAt, payload.dialogueId, payload.ruleId, payload.mode, payload.note
        )

    try:
        return await jobs.perform('tone-advice', work)
    except BusyError as error:
        raise HTTPException(409, str(error)) from error
    except asyncio.CancelledError as error:
        raise HTTPException(409, 'Подготовка предложения остановлена') from error
    except ValueError as error:
        raise HTTPException(400, str(error)) from error
    except llm.ModelError as error:
        raise HTTPException(502, str(error)) from error


@app.post('/api/tone-of-voice/clarification')
async def tone_clarification(payload: ToneClarificationCommand) -> dict:
    async def work(progress: Progress) -> dict:
        draft = tone.clarified(payload.revision, payload.ruleId, payload.text)
        store.save_tone_draft(draft)
        return draft

    try:
        return await jobs.perform('tone-clarification', work)
    except BusyError as error:
        raise HTTPException(409, str(error)) from error
    except ValueError as error:
        raise HTTPException(400, str(error)) from error


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


def has_verdict(analysis: dict, dialogue_id: str, rule_id: str) -> bool:
    return any(
        str(result.get('dialogueId')) == dialogue_id and any(row.get('ruleId') == rule_id for row in result['rules'])
        for result in analysis.get('results') or []
        if result.get('rules')
    )


def answered_check(payload: ReviewCommand) -> str:
    """The check whose result an answer on a logged conversation goes to: the one it names, else the one whose result
    the person saw (finishedAt), else the first whose result has this verdict."""
    if payload.check:
        return payload.check
    results = {check: store.load(checks.result(check)) or {} for check in checks.RESULTS}
    if payload.finishedAt:
        found = next((key for key, value in results.items() if value.get('finishedAt') == payload.finishedAt), None)
        if found is None:
            raise HTTPException(409, store.CHANGED)
        return found
    found = next(
        (key for key, value in results.items() if has_verdict(value, payload.dialogueId, payload.ruleId)), None
    )
    if found is None:
        raise HTTPException(404, NOT_CHECKED)
    return found


@app.post('/api/review')
async def review(payload: ReviewCommand) -> dict:
    if payload.source == 'log':
        if not payload.dialogueId or not payload.ruleId:
            raise HTTPException(422, 'Нужны dialogueId и ruleId')
        check = answered_check(payload)
        if jobs.state['running'] and WRITES.get(jobs.state['kind']) == check:
            raise HTTPException(409, f'Идёт проверка «{checks.NAMES[check]}»: ответ не сохранится. Отметьте после неё.')
        try:
            store.set_log_review(
                checks.result(check),
                payload.dialogueId,
                payload.ruleId,
                payload.decision,
                payload.finishedAt,
                payload.status,
            )
        except KeyError as error:
            raise HTTPException(404, NOT_CHECKED) from error
        except ValueError as error:
            raise HTTPException(409, str(error)) from error
        return {'ok': True}
    if payload.index is None:
        raise HTTPException(422, 'Нужны run и index')
    try:
        record = store.set_review(payload.run, payload.index, payload.decision, payload.ruleId or None, payload.status)
    except (KeyError, IndexError) as error:
        raise HTTPException(404, 'Разговор не найден') from error
    except ValueError as error:
        raise HTTPException(409, str(error)) from error
    return {'ok': True, 'metric': record['metric']}
