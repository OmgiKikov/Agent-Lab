"""Agent Lab HTTP commands. Long work has one owner per agent (app.state.jobs); computation precedes persistence."""

import asyncio
import hashlib
import json
from typing import Annotated, Literal

from fastapi import APIRouter, Body, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from . import agents, models, registry, store
from .agents import knowledge
from .domain import checks, export, personas, policy_files, results
from .flows import (
    Progress,
    accuracy,
    advice,
    connection,
    inputs,
    scenarios,
    severity,
    simulation,
    tone,
)
from .flows import checks as results_of
from .jobs import BusyError, PerAgent, Work

router = APIRouter()


async def jobs_of(request: Request) -> PerAgent:
    """The owner of long work of the app the request came to (app.create): one per agent."""
    return request.app.state.jobs


Jobs = Annotated[PerAgent, Depends(jobs_of)]


RUN_FIELDS = (
    'id', 'target', 'targetName', 'version', 'label', 'startedAt', 'finishedAt', 'status', 'metric', 'error',
    'model', 'repeats', 'personas', 'updatedAt', 'revision', 'check',
)  # fmt: skip
# The job that writes a check's result: while it runs, answers on that result would be lost (review).
WRITES = {'tone-check': checks.TONE, 'discover': checks.CODE}


class DiscoverCommand(BaseModel):
    count: int = Field(default=60, ge=5, le=300)
    replan: bool = False
    # After the check the model proposes which errors are serious (severity.propose); the screens ask for it.
    propose: bool = False


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
    name: str = Field(default='Правила общения', min_length=1, max_length=160)


class ToneCopyCommand(BaseModel):
    agent: str = Field(min_length=1, max_length=120)


class SeverityCommand(BaseModel):
    """A person decides whether the errors of a criterion of a check are serious; the criterion by its key."""

    check: Literal['tone', 'code']
    rule: str = Field(pattern=r'^r-[0-9a-f]{10}$')
    serious: bool


class SeverityProposeCommand(BaseModel):
    """The model proposes for the criteria of a check's result it has no proposal for (every one `again`)."""

    check: Literal['tone', 'code']
    again: bool = False


class SeverityConfirmCommand(BaseModel):
    """A person takes every proposal of the model for a check's criteria as their own decision."""

    check: Literal['tone', 'code']


class ToneCheckCommand(BaseModel):
    ruleIds: list[str] = Field(min_length=1, max_length=20)
    count: int = Field(default=300, ge=1, le=300)
    revision: str | None = None
    # After the check the model proposes which errors are serious (severity.propose); the screens ask for it.
    propose: bool = False


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
    result it goes to. finishedAt (the check's result), status (the verdict) and before (the answer on it, null for
    none) are what the person saw: when any changed meanwhile, the decision is refused. Without before (older
    screens) the answer on the case is not compared."""

    source: Literal['log', 'sim'] = 'sim'
    check: Literal['tone', 'code'] | None = None
    run: str = ''
    index: int | None = Field(default=None, ge=0, strict=True)
    dialogueId: str = ''
    ruleId: str = ''
    decision: Literal['agree', 'disagree'] | None = None
    finishedAt: str | None = None
    status: str | None = None
    before: Literal['agree', 'disagree'] | None = None

    def seen(self) -> object:
        """The answer the person saw on the case, or store.UNSEEN when the request does not say."""
        return self.before if 'before' in self.model_fields_set else store.UNSEEN


class CardsCommand(BaseModel):
    check: Literal['tone', 'code'] | None = None


def start(jobs: PerAgent, kind: str, work: Work) -> dict:
    try:
        return jobs.start(kind, work)
    except BusyError as error:
        raise HTTPException(409, str(error)) from error


class AgentCommand(BaseModel):
    name: str = Field(max_length=80)
    description: str = Field(default='', max_length=200)


def reviews_stamp(found: dict[str, dict | None]) -> str:
    """What changes with every answer on the checks' results, given in this tab, another one or another browser: the
    screens ask for the problems again by it, so a case answered elsewhere is never offered again as unanswered."""
    answers = sorted(
        (check, str(result.get('dialogueId')), str(row.get('ruleId')), row['review'])
        for check, value in found.items()
        for result in (value or {}).get('results') or []
        for row in result.get('rules') or []
        if row.get('review') in ('agree', 'disagree')
    )
    return hashlib.sha1(json.dumps(answers, ensure_ascii=False).encode()).hexdigest()[:12]


@router.get('/api/agents')
def agents_view() -> list[dict]:
    """Every agent with the result of each of its checks and its rules of communication, read from its own database.
    Never ranked: the agents have other dialogues and other rules; nor are an agent's two checks added up."""
    listed = []
    for agent in registry.listed():
        with registry.using(agent['id']):
            lines = {check: results_of.line(check) for check in checks.RESULTS}
            listed.append({**agent, 'results': lines, 'rules': tone.rules_line()})
    return listed


@router.post('/api/agents')
def create_agent(payload: AgentCommand) -> dict:
    try:
        return registry.create(payload.name, payload.description)
    except ValueError as error:
        raise HTTPException(400, str(error)) from error


@router.post('/api/job/stop')
async def stop_job(jobs: Jobs) -> dict:
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
        for source in inputs.sources()
    ]


@router.get('/api/state')
def state(jobs: Jobs) -> dict:
    """Polled every 1.5 s during a job: each check's result is read once; runs and dialogues are not parsed at all.
    The task is read first, as it stands: it runs on while this answer is put together in a worker thread, and a task
    said to be finished has its data in the same answer (a live state would say «done» beside the data it replaced)."""
    job = dict(jobs.state)
    found = {check: store.load(checks.result(check)) for check in checks.RESULTS}
    for result in filter(None, found.values()):
        if not result.get('summary'):  # every result stores its summary; an older one may not
            result['summary'] = results.summarize(result['results'], result['topics'])
        result['summary'] = results.with_unmeasured(result['summary'], result.get('sampled'))
    return {
        'job': job,
        'model': models.main_model(),
        'models': models.describe(),
        'settings': connection.settings(),
        'sources': source_summary(found[checks.CODE]),
        'sourcesRead': store.load(inputs.SOURCES_READ),
        'logs': {'total': store.dialogue_count(), **store.export_meta()},
        'checks': found,
        'reviewsStamp': reviews_stamp(found),
        'toneOfVoice': store.load(tone.DRAFT),
        'severity': store.severity(),
        'severityStamp': store.severity_stamp(),
        'cards': store.load(scenarios.DECK),
        'runs': [
            {key: summary.get(key) for key in RUN_FIELDS} | {'targetName': agents.run_name(summary)}
            for summary in store.run_summaries()
        ],
        'targets': [agents.public(key, way) for key, way in connection.ways().items()],
        'personas': personas.public(),
    }


@router.post('/api/settings')
async def save_settings(jobs: Jobs, payload: SettingsCommand) -> dict:
    if jobs.state['running']:
        raise HTTPException(409, 'Настройки нельзя менять, пока идёт задача. Дождитесь её или остановите.')
    try:
        return connection.save_settings(payload.model_dump(exclude_unset=True))
    except ValueError as error:
        raise HTTPException(400, str(error)) from error


@router.post('/api/agents/{key}/check')
async def check_agent(key: str) -> dict:
    if key not in connection.ways():
        raise HTTPException(404, connection.UNKNOWN_WAY)
    try:
        return await connection.check(key)
    except ValueError as error:
        raise HTTPException(400, str(error)) from error


@router.post('/api/models/check')
async def check_models() -> dict:
    main, endpoint = models.endpoints().main, models.second_judge()
    if endpoint is None:
        return {'main': await models.check(main), 'second': None}
    main, second = await asyncio.gather(models.check(main), models.check(endpoint))
    return {'main': main, 'second': second}


@router.post('/api/sources')
async def collect_sources(jobs: Jobs) -> dict:
    return start(jobs, 'sources', lambda progress: inputs.read_code())


async def uploaded(request: Request, limit: int, advice: str) -> bytes:
    """The uploaded file: refused by its declared length before a byte is read, and never read past the limit; the
    refusal says what to do (advice)."""
    size = f'{limit / 1_000_000:g}'.replace('.', ',')
    message = f'Файл больше {size}\u00a0МБ. {advice}'
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


@router.post('/api/logs')
async def upload_logs(jobs: Jobs, request: Request, name: str) -> dict:
    data = await uploaded(request, export.LIMIT, 'Выгрузите разговоры за меньший срок.')
    try:
        return await jobs.perform('logs', lambda progress: inputs.upload_export(name, data))
    except BusyError as error:
        raise HTTPException(409, str(error)) from error
    except asyncio.CancelledError as error:
        raise HTTPException(409, 'Загрузка остановлена') from error
    except (ValueError, KeyError, OSError) as error:
        raise HTTPException(400, f'Не удалось прочитать файл. {error}') from error


@router.get('/api/logs/{dialogue_id}')
def log_detail(dialogue_id: str, check: Literal['tone', 'code'] | None = None) -> dict:
    """A logged conversation with its evaluation in the result of the check asked for; without one, in tone of voice's
    result, then in Точность's."""
    found = results_of.conversation(dialogue_id, check)
    if found is None:
        raise HTTPException(404, 'Разговор не найден')
    return found


@router.get('/api/problems')
def problems_view(check: Literal['tone', 'code'] = checks.TONE, run: str | None = None) -> dict:
    """Every rule of one check with its verdicts in the logs and in one run of that check; the rules found violated
    are the problems. A run is measured by its own check's criteria, so its check is taken; without either, tone of
    voice (older links)."""
    if run:
        record = store.run(run)
        if record is None:
            raise HTTPException(404, 'Прогон не найден')
        check = checks.of_run(record)
    return results_of.problems(check, run)


@router.post('/api/severity')
def mark_severity(payload: SeverityCommand) -> dict:
    """A person decides whether a criterion's errors are serious or minor
    (docs/superpowers/specs/2026-10-04-severity-design.md): serious ones come first and are counted apart. The decision
    wins over the model's proposal and changes neither what is checked nor how."""
    return {'severity': store.set_severity(payload.check, payload.rule, payload.serious)}


@router.post('/api/severity/propose')
async def propose_severity(jobs: Jobs, payload: SeverityProposeCommand) -> dict:
    """«Предложить»: the model proposes which errors of the check's criteria are serious."""
    return start(
        jobs, 'severity', lambda progress: severity.propose_again(payload.check, progress, again=payload.again)
    )


@router.post('/api/severity/confirm')
def confirm_severity(payload: SeverityConfirmCommand) -> dict:
    """«Подтвердить все»: a person takes the model's proposals for the criteria of the check's result as their own."""
    return severity.confirm(payload.check)


@router.get('/api/compare')
def compare_view(check: Literal['tone', 'code'] = checks.TONE) -> dict:
    """«Было → стало»: the check's current result against its previous saved check, criterion by criterion, when both
    have the same criteria and models; otherwise only how they stand to each other. Reads saved records only."""
    return results_of.comparison(check)


@router.get('/api/history/{check}')
def history_view(check: Literal['tone', 'code']) -> dict:
    """The saved checks of one check, the newest first, each with how it stands to the one saved before it."""
    return {'checks': results_of.saved_checks(check)}


@router.get('/api/history/{check}/{check_id}')
def history_detail(check: Literal['tone', 'code'], check_id: str) -> dict:
    """A saved check with its evidence and the answers given on it: tone of voice's as /api/tone-of-voice/history/{id};
    Точность's with its result and the conversations it judged."""
    return saved(check, check_id)


def saved(check: str, check_id: str) -> dict:
    found = results_of.with_reviews(check, check_id)
    if found is None:
        raise HTTPException(404, 'Проверка не найдена')
    return found


@router.get('/api/scenarios')
def scenarios_view() -> dict:
    """Each scenario of the deck as a test: the error of the real conversation it reproduces, and its own result in
    every run of the deck's check, newest first. Results of runs stand side by side; nothing compares them."""
    return scenarios.listed()


@router.get('/api/sources/{source_id}')
def source_view(source_id: str) -> dict:
    """The text of a source the rules are quoted from: a prompt or the list of the agent's tools."""
    found = next((source for source in inputs.sources() if source['id'] == source_id), None)
    if found is None:
        raise HTTPException(404, 'Источник не найден')
    return {key: found.get(key) for key in ('id', 'kind', 'origin', 'sha256', 'content')}


@router.get('/api/articles/{article_id}')
def article_view(article_id: str) -> dict:
    """A knowledge-base article the agent read during a simulated turn: its title and text."""
    found = knowledge.article(connection.repo(), article_id)
    if found is None:
        raise HTTPException(404, 'Статьи нет в базе знаний агента')
    return found


@router.get('/api/runs/{run_id}')
def run_detail(run_id: str) -> dict:
    record = store.run(run_id)
    if record is None:
        raise HTTPException(404, 'Прогон не найден')
    return record


@router.post('/api/discover')
async def start_discover(jobs: Jobs, payload: DiscoverCommand | None = Body(default=None)) -> dict:
    payload = payload or DiscoverCommand()
    return start(
        jobs,
        'discover',
        lambda progress: accuracy.check(payload.count, progress, replan=payload.replan, propose=payload.propose),
    )


@router.post('/api/cards')
async def start_cards(jobs: Jobs, payload: CardsCommand | None = Body(default=None)) -> dict:
    """Scenarios from the errors of one check: the one asked for, else the only check with a result."""
    try:
        check = scenarios.chosen_check(payload.check if payload else None)
    except ValueError as error:
        raise HTTPException(400, str(error)) from error
    return start(jobs, 'cards', lambda progress: scenarios.build(check, progress))


@router.post('/api/tone-of-voice/policy')
async def save_tone_policy(jobs: Jobs, payload: TonePolicyCommand) -> dict:
    async def work(progress: Progress) -> dict:
        inputs.save_policy(payload.name, payload.text)
        return {'ok': True}

    try:
        return await jobs.perform('tone-policy', work)
    except BusyError as error:
        raise HTTPException(409, str(error)) from error
    except ValueError as error:
        raise HTTPException(400, str(error)) from error


@router.post('/api/tone-of-voice/copy')
async def copy_tone_rules(jobs: Jobs, payload: ToneCopyCommand) -> dict:
    """The rules of communication of another agent (`agent`) and their criteria, with the clarifications people
    confirmed, become this agent's own as a copy: later changes in either never reach the other (tone.take). The
    marks of serious errors come with the criteria. `unchanged` when this agent had the same rules, criteria and marks
    already."""
    try:
        _, found, marks, proposed = tone.copied_from(payload.agent)
    except LookupError as error:
        raise HTTPException(404, str(error)) from error
    except ValueError as error:
        raise HTTPException(400, str(error)) from error
    try:
        return await jobs.perform('tone-policy', lambda progress: _copied(found, marks, proposed))
    except BusyError as error:
        raise HTTPException(409, str(error)) from error


async def _copied(found: tuple[dict, dict | None], marks: dict[str, bool], proposed: dict) -> dict:
    return tone.copy(found, marks, proposed)


@router.post('/api/tone-of-voice/read-file')
async def read_tone_file(request: Request, name: str) -> dict:
    data = await uploaded(request, policy_files.LIMIT, 'Оставьте в файле только правила общения.')
    try:
        text = await asyncio.to_thread(policy_files.read, name, data)
    except ValueError as error:
        raise HTTPException(400, str(error)) from error
    return {'text': text, 'name': name}


@router.post('/api/tone-of-voice/criteria')
async def prepare_tone_criteria(jobs: Jobs) -> dict:
    return start(jobs, 'tone-criteria', tone.collect_criteria)


@router.post('/api/tone-of-voice/check')
async def check_tone(jobs: Jobs, payload: ToneCheckCommand) -> dict:
    try:
        criteria = tone.selection(payload.ruleIds, payload.revision)
    except ValueError as error:
        raise HTTPException(400, str(error)) from error
    return start(
        jobs, 'tone-check', lambda progress: tone.check(criteria, payload.count, progress, propose=payload.propose)
    )


@router.get('/api/tone-of-voice/history')
def tone_history() -> dict:
    result = store.load(tone.RESULT) or {}
    return {
        'checks': store.tone_checks(),
        'hasLegacyResult': result.get('purpose') == checks.TONE_OF_VOICE and not result.get('checkId'),
    }


@router.get('/api/tone-of-voice/history/{check_id}')
def tone_history_detail(check_id: str) -> dict:
    return saved(checks.TONE, check_id)


@router.post('/api/tone-of-voice/advice')
async def tone_advice_command(jobs: Jobs, payload: ToneAdviceCommand) -> dict:
    async def work(progress: Progress) -> dict:
        progress(message='Готовим предложение')
        return await advice.suggest(payload.finishedAt, payload.dialogueId, payload.ruleId, payload.mode, payload.note)

    try:
        return await jobs.perform('tone-advice', work)
    except BusyError as error:
        raise HTTPException(409, str(error)) from error
    except asyncio.CancelledError as error:
        raise HTTPException(409, 'Подготовка предложения остановлена') from error
    except ValueError as error:
        raise HTTPException(400, str(error)) from error
    except models.ModelError as error:
        raise HTTPException(502, str(error)) from error


@router.post('/api/tone-of-voice/clarification')
async def tone_clarification(jobs: Jobs, payload: ToneClarificationCommand) -> dict:
    async def work(progress: Progress) -> dict:
        return tone.clarify(payload.revision, payload.ruleId, payload.text)

    try:
        return await jobs.perform('tone-clarification', work)
    except BusyError as error:
        raise HTTPException(409, str(error)) from error
    except ValueError as error:
        raise HTTPException(400, str(error)) from error


@router.post('/api/runs')
async def start_run(jobs: Jobs, payload: RunCommand) -> dict:
    if payload.target not in connection.ways():
        raise HTTPException(400, connection.UNKNOWN_WAY)
    chosen = [key for key in payload.personas if key in personas.PERSONAS] or [personas.DEFAULT]
    return start(
        jobs,
        'run',
        lambda progress: simulation.run(
            payload.target, payload.cardIds or None, payload.label, progress, payload.repeats, chosen
        ),
    )


@router.post('/api/runs/{run_id}/rejudge')
async def rejudge(jobs: Jobs, run_id: str) -> dict:
    record = store.run(run_id)
    if record is None:
        raise HTTPException(404, 'Прогон не найден')
    return start(jobs, 'rejudge', lambda progress: simulation.rejudge(record, progress))


@router.post('/api/review')
async def review(jobs: Jobs, payload: ReviewCommand) -> dict:
    if payload.source == 'log':
        if not payload.dialogueId or not payload.ruleId:
            raise HTTPException(422, 'Нужны dialogueId и ruleId')
        try:
            check = results_of.answered_check(payload.check, payload.finishedAt, payload.dialogueId, payload.ruleId)
        except ValueError as error:
            raise HTTPException(409, str(error)) from error
        except LookupError as error:
            raise HTTPException(404, str(error)) from error
        if jobs.state['running'] and WRITES.get(jobs.state['kind']) == check:
            raise HTTPException(
                409, f'Ответ не сохранится, пока идёт проверка «{checks.NAMES[check]}». Ответьте после неё.'
            )
        try:
            store.set_log_review(
                checks.result(check),
                payload.dialogueId,
                payload.ruleId,
                payload.decision,
                payload.finishedAt,
                payload.status,
                payload.seen(),
            )
        except KeyError as error:
            raise HTTPException(404, results_of.NOT_CHECKED) from error
        except ValueError as error:
            raise HTTPException(409, str(error)) from error
        return {'ok': True}
    if payload.index is None:
        raise HTTPException(422, 'Нужны run и index')
    try:
        record = store.set_review(
            payload.run, payload.index, payload.decision, payload.ruleId or None, payload.status, payload.seen()
        )
    except (KeyError, IndexError) as error:
        raise HTTPException(404, 'Разговор не найден') from error
    except ValueError as error:
        raise HTTPException(409, str(error)) from error
    return {'ok': True, 'metric': record['metric']}
