"""Agent Lab HTTP commands. Long work has one owner per agent (app.state.jobs); computation precedes persistence."""

import asyncio
import hashlib
import json
import uuid
from typing import Annotated, Literal

from fastapi import APIRouter, Body, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from . import (
    accuracy_history,
    agents,
    cards,
    checks,
    compare,
    discover,
    history,
    logs,
    models,
    personas,
    policy_files,
    problems,
    registry,
    scenarios,
    severity,
    simulate,
    store,
    tone,
    tone_advice,
)
from .context import knowledge, sources
from .jobs import BusyError, PerAgent, Progress, Work

router = APIRouter()


async def jobs_of(request: Request) -> PerAgent:
    """The owner of long work of the app the request came to (app.create): one per agent."""
    return request.app.state.jobs


Jobs = Annotated[PerAgent, Depends(jobs_of)]


RUN_FIELDS = (
    'id', 'target', 'targetName', 'version', 'label', 'startedAt', 'finishedAt', 'status', 'metric', 'error',
    'model', 'repeats', 'personas', 'updatedAt', 'revision', 'check',
)  # fmt: skip
CHECK_QUESTION = 'Какой процент эквайринга?'
# The job that writes a check's result: while it runs, answers on that result would be lost (review).
WRITES = {'tone-check': checks.TONE, 'discover': checks.CODE}
NOT_CHECKED = 'Этот критерий в разговоре не проверялся.'  # an answer on a logged conversation without this verdict
UNKNOWN_WAY = 'Неизвестный способ подключения агента.'  # a target the service does not have (agents.configs)


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


def result_line(check: str) -> dict | None:
    """The current agent's result of one check in one line: errors of measured, not checked, when."""
    value = store.load(checks.result(check)) or {}
    summary = history.with_unmeasured(value.get('summary') or {}, value.get('sampled'))
    if not value.get('finishedAt') or any(key not in summary for key in ('failed', 'measured', 'unmeasured')):
        return None  # nothing finished, or a record of another shape: never a reason to hide the other agents
    return {key: summary[key] for key in ('failed', 'measured', 'unmeasured')} | {'finishedAt': value['finishedAt']}


def reviews_stamp(results: dict[str, dict | None]) -> str:
    """What changes with every answer on the checks' results, given in this tab, another one or another browser: the
    screens ask for the problems again by it, so a case answered elsewhere is never offered again as unanswered."""
    answers = sorted(
        (check, str(result.get('dialogueId')), str(row.get('ruleId')), row['review'])
        for check, value in results.items()
        for result in (value or {}).get('results') or []
        for row in result.get('rules') or []
        if row.get('review') in ('agree', 'disagree')
    )
    return hashlib.sha1(json.dumps(answers, ensure_ascii=False).encode()).hexdigest()[:12]


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


@router.get('/api/agents')
def agents_view() -> list[dict]:
    """Every agent with the result of each of its checks and its rules of communication, read from its own database.
    Never ranked: the agents have other dialogues and other rules; nor are an agent's two checks added up."""
    listed = []
    for agent in registry.listed():
        with registry.using(agent['id']):
            results = {check: result_line(check) for check in checks.RESULTS}
            listed.append({**agent, 'results': results, 'rules': rules_line()})
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
        for source in sources.load()
    ]


@router.get('/api/state')
def state(jobs: Jobs) -> dict:
    """Polled every 1.5 s during a job: each check's result is read once; runs and dialogues are not parsed at all.
    The task is read first, as it stands: it runs on while this answer is put together in a worker thread, and a task
    said to be finished has its data in the same answer (a live state would say «done» beside the data it replaced)."""
    job = dict(jobs.state)
    results = {check: store.load(checks.result(check)) for check in checks.RESULTS}
    for result in filter(None, results.values()):
        if not result.get('summary'):  # every result stores its summary; an older one may not
            result['summary'] = discover.summarize(result['results'], result['topics'])
        result['summary'] = history.with_unmeasured(result['summary'], result.get('sampled'))
    return {
        'job': job,
        'model': models.main_model(),
        'models': models.describe(),
        'settings': agents.settings(),
        'sources': source_summary(results[checks.CODE]),
        'sourcesRead': store.load(sources.READ),
        'logs': {'total': store.length(logs.FILE), **logs.meta()},
        'checks': results,
        'reviewsStamp': reviews_stamp(results),
        'toneOfVoice': store.load(tone.DRAFT),
        'severity': store.severity(),
        'severityStamp': store.severity_stamp(),
        'cards': store.load(cards.DECK),
        'runs': [
            {key: summary.get(key) for key in RUN_FIELDS} | {'targetName': agents.run_name(summary)}
            for summary in store.run_summaries()
        ],
        'targets': [agents.public(key, config) for key, config in agents.configs().items()],
        'personas': personas.public(),
    }


@router.post('/api/settings')
async def save_settings(jobs: Jobs, payload: SettingsCommand) -> dict:
    if jobs.state['running']:
        raise HTTPException(409, 'Настройки нельзя менять, пока идёт задача. Дождитесь её или остановите.')
    try:
        return agents.save_settings(payload.model_dump(exclude_unset=True))
    except ValueError as error:
        raise HTTPException(400, str(error)) from error


@router.post('/api/agents/{key}/check')
async def check_agent(key: str) -> dict:
    if key not in agents.configs():
        raise HTTPException(404, UNKNOWN_WAY)
    agent = agents.create(key)
    if isinstance(agent, agents.CodeAgent):
        raise HTTPException(
            400, 'Агент из кода запускается только на время прогона, поэтому связь заранее не проверить.'
        )
    try:
        async with agents.session(agent):
            reply = await agent.say(str(uuid.uuid4()), CHECK_QUESTION)
        return {'ok': True, 'question': CHECK_QUESTION, 'version': agent.version, **reply}
    except agents.AgentError as error:
        return {'ok': False, 'error': str(error)}


@router.post('/api/models/check')
async def check_models() -> dict:
    main, endpoint = models.endpoints().main, models.second_judge()
    if endpoint is None:
        return {'main': await models.check(main), 'second': None}
    main, second = await asyncio.gather(models.check(main), models.check(endpoint))
    return {'main': main, 'second': second}


@router.post('/api/sources')
async def collect_sources(jobs: Jobs) -> dict:
    async def work(progress: Progress) -> list[dict]:
        folder = agents.settings()['repo']
        collected, over_budget = await asyncio.to_thread(sources.collect, agents.repo())
        # The tone-of-voice policy is a person's document, not the agent's code: re-reading the code keeps it.
        policy = [source for source in sources.load() if source['kind'] == tone.KIND]
        read = {'readAt': store.now(), 'repo': folder, 'overBudget': over_budget}
        store.replace_inputs(sources.FILE, [*collected, *policy], {sources.READ: read})
        return collected

    return start(jobs, 'sources', work)


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
    data = await uploaded(request, logs.LIMIT, 'Выгрузите разговоры за меньший срок.')

    async def work(progress: Progress) -> dict:
        dialogues, skipped = await asyncio.to_thread(logs.read_export, name, data)
        # skipped: the conversations a check cannot read (the agent wrote first, or never answered), left out.
        return {'total': logs.commit(dialogues, name), 'skipped': skipped}

    try:
        return await jobs.perform('logs', work)
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
    return problems.build(check, run)


@router.post('/api/severity')
def mark_severity(payload: SeverityCommand) -> dict:
    """A person decides whether a criterion's errors are serious or minor
    (docs/superpowers/specs/2026-10-04-severity-design.md): serious ones come first and are counted apart. The decision
    wins over the model's proposal and changes neither what is checked nor how."""
    return {'severity': store.set_severity(payload.check, payload.rule, payload.serious)}


@router.post('/api/severity/propose')
async def propose_severity(jobs: Jobs, payload: SeverityProposeCommand) -> dict:
    """«Предложить»: the model proposes which errors of the check's criteria are serious — for a result checked before
    proposals, after a failed proposal, or `again` for every criterion a person has not decided."""

    async def work(progress: Progress) -> dict:
        progress(message=severity.PROPOSING, check=payload.check)
        error = await severity.propose(payload.check, progress, again=payload.again)
        if error:
            raise models.ModelError(error)
        return {'severity': store.severity()}

    return start(jobs, 'severity', work)


@router.post('/api/severity/confirm')
def confirm_severity(payload: SeverityConfirmCommand) -> dict:
    """«Подтвердить все»: a person takes the model's proposals for the criteria of the check's result as their own."""
    return {'severity': store.confirm_severity(payload.check, list(severity.criteria(payload.check)))}


@router.get('/api/compare')
def compare_view(check: Literal['tone', 'code'] = checks.TONE) -> dict:
    """«Было → стало»: the check's current result against its previous saved check, criterion by criterion, when both
    have the same criteria and models; otherwise only how they stand to each other. Reads saved records only."""
    return compare.build(check)


@router.get('/api/history/{check}')
def history_view(check: Literal['tone', 'code']) -> dict:
    """The saved checks of one check, the newest first, each with how it stands to the one saved before it."""
    return {'checks': compare.saved_checks(check)}


@router.get('/api/history/{check}/{check_id}')
def history_detail(check: Literal['tone', 'code'], check_id: str) -> dict:
    """A saved check with its evidence and the answers given on it: tone of voice's as /api/tone-of-voice/history/{id};
    Точность's with its result and the conversations it judged."""
    if check == checks.TONE:
        return tone_history_detail(check_id)
    return with_reviews(store.code_check(check_id), store.code_reviews(check_id))


@router.get('/api/scenarios')
def scenarios_view() -> dict:
    """Each scenario of the deck as a test: the error of the real conversation it reproduces, and its own result in
    every run of the deck's check, newest first. Results of runs stand side by side; nothing compares them."""
    return scenarios.build()


@router.get('/api/sources/{source_id}')
def source_view(source_id: str) -> dict:
    """The text of a source the rules are quoted from: a prompt or the list of the agent's tools."""
    found = next((source for source in sources.load() if source['id'] == source_id), None)
    if found is None:
        raise HTTPException(404, 'Источник не найден')
    return {key: found.get(key) for key in ('id', 'kind', 'origin', 'sha256', 'content')}


@router.get('/api/articles/{article_id}')
def article_view(article_id: str) -> dict:
    """A knowledge-base article the agent read during a simulated turn: its title and text."""
    found = knowledge.article(article_id)
    if found is None:
        raise HTTPException(404, 'Статьи нет в базе знаний агента')
    return found


@router.get('/api/runs/{run_id}')
def run_detail(run_id: str) -> dict:
    record = store.run(run_id)
    if record is None:
        raise HTTPException(404, 'Прогон не найден')
    return record


async def proposed_after(check: str, progress: Progress) -> None:
    """The serious errors the model proposes after a check it follows, which is published by then. «Остановить» here
    stops only the proposals: the task ends as done, with the check saved, never «Остановлено» beside a result that
    stands. Each answered part is saved at once (severity.propose); «Отметить автоматически» asks for the rest."""
    try:
        await severity.propose(check, progress)
    except asyncio.CancelledError:
        current = asyncio.current_task()
        if current is not None:
            current.uncancel()


@router.post('/api/discover')
async def start_discover(jobs: Jobs, payload: DiscoverCommand | None = Body(default=None)) -> dict:
    payload = payload or DiscoverCommand()

    async def work(progress: Progress) -> dict:
        result = await discover.run(payload.count, progress, payload.replan)
        accuracy_history.commit(result, new_criteria=payload.replan)
        if payload.propose:
            await proposed_after(checks.CODE, progress)
        return result

    return start(jobs, 'discover', work)


@router.post('/api/cards')
async def start_cards(jobs: Jobs, payload: CardsCommand | None = Body(default=None)) -> dict:
    """Scenarios from the errors of one check: the one asked for, else the only check with a result."""
    check = payload.check if payload else None
    if check is None:
        found = [key for key in checks.RESULTS if store.load(checks.result(key))]
        if len(found) > 1:
            raise HTTPException(400, 'Выберите, из какой проверки собрать сценарии.')
        check = next(iter(found), None)

    async def work(progress: Progress) -> list[dict]:
        if check is None:
            raise RuntimeError('Сценарии собираются из найденных ошибок. Сначала проверьте разговоры.')
        deck = await cards.run(check, progress)
        document = {'check': check, 'createdAt': store.now(), 'model': models.models_used(deck), 'cards': deck}
        store.save(cards.DECK, document)
        return deck

    return start(jobs, 'cards', work)


@router.post('/api/tone-of-voice/policy')
async def save_tone_policy(jobs: Jobs, payload: TonePolicyCommand) -> dict:
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


@router.post('/api/tone-of-voice/copy')
async def copy_tone_rules(jobs: Jobs, payload: ToneCopyCommand) -> dict:
    """The rules of communication of another agent (`agent`) and their criteria, with the clarifications people
    confirmed, become this agent's own as a copy: later changes in either never reach the other (tone.take). The
    marks of serious errors come with the criteria. `unchanged` when this agent had the same rules, criteria and marks
    already."""
    source = registry.get(payload.agent)
    if source is None:
        raise HTTPException(404, 'Агент не найден')
    if registry.db_of(source['id']) == store.database():
        raise HTTPException(400, 'Правила можно взять только у другого агента.')
    with registry.using(source['id']):
        found = tone.rules()
        marks = store.severity_marks()[checks.TONE]
        proposed = store.severity_proposed()[checks.TONE]
    if found is None:
        raise HTTPException(400, f'У агента «{source["name"]}» нет правил общения.')

    async def work(progress: Progress) -> dict:
        changed = tone.take(*found)
        # Serious or minor belongs to the criteria (problems.rule_key): a person's decisions and the model's proposals
        # come with criteria, never with rules alone, and other ones on the same criteria are a change.
        own = (store.severity_marks()[checks.TONE], store.severity_proposed()[checks.TONE]['proposals'])
        if found[1] is not None and own != (marks, proposed['proposals']):
            store.take_severity(checks.TONE, marks, proposed)
            changed = True
        return {'ok': True, 'unchanged': not changed}

    try:
        return await jobs.perform('tone-policy', work)
    except BusyError as error:
        raise HTTPException(409, str(error)) from error


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
    async def work(progress: Progress) -> dict:
        draft = await tone.prepare(progress)
        store.save_tone_draft(draft)
        return draft

    return start(jobs, 'tone-criteria', work)


@router.post('/api/tone-of-voice/check')
async def check_tone(jobs: Jobs, payload: ToneCheckCommand) -> dict:
    try:
        criteria = tone.selection(payload.ruleIds, payload.revision)
    except ValueError as error:
        raise HTTPException(400, str(error)) from error

    async def work(progress: Progress) -> dict:
        result = await tone.assess(criteria, payload.count, progress)
        tone.commit(result)
        if payload.propose:
            await proposed_after(checks.TONE, progress)
        return result

    return start(jobs, 'tone-check', work)


@router.get('/api/tone-of-voice/history')
def tone_history() -> dict:
    result = store.load(tone.RESULT) or {}
    return {
        'checks': store.tone_checks(),
        'hasLegacyResult': result.get('purpose') == tone.KIND and not result.get('checkId'),
    }


@router.get('/api/tone-of-voice/history/{check_id}')
def tone_history_detail(check_id: str) -> dict:
    return with_reviews(store.tone_check(check_id), store.tone_reviews(check_id))


def with_reviews(snapshot: dict | None, reviews: list[dict]) -> dict:
    """A saved check with the answers people gave on it since it finished, over the ones it was saved with."""
    if snapshot is None:
        raise HTTPException(404, 'Проверка не найдена')
    for record in (snapshot['check'], snapshot['result']):
        if isinstance(record.get('summary'), dict):
            record['summary'] = history.with_unmeasured(record['summary'], record.get('sampled'))
    decisions = {(row['dialogueId'], row['ruleId']): row['decision'] for row in reviews}
    for result in snapshot['result']['results']:
        for row in result.get('rules', []):
            key = (str(result['dialogueId']), row['ruleId'])
            if key in decisions:
                row['review'] = decisions[key]
    snapshot.update(reviews=reviews, reviewSemantics='latest-saved')
    return snapshot


@router.post('/api/tone-of-voice/advice')
async def tone_advice_command(jobs: Jobs, payload: ToneAdviceCommand) -> dict:
    async def work(progress: Progress) -> dict:
        progress(message='Готовим предложение')
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
    except models.ModelError as error:
        raise HTTPException(502, str(error)) from error


@router.post('/api/tone-of-voice/clarification')
async def tone_clarification(jobs: Jobs, payload: ToneClarificationCommand) -> dict:
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


@router.post('/api/runs')
async def start_run(jobs: Jobs, payload: RunCommand) -> dict:
    if payload.target not in agents.configs():
        raise HTTPException(400, UNKNOWN_WAY)
    chosen = [key for key in payload.personas if key in personas.PERSONAS] or [personas.DEFAULT]
    return start(
        jobs,
        'run',
        lambda progress: simulate.run(
            payload.target, payload.cardIds or None, payload.label, progress, payload.repeats, chosen
        ),
    )


@router.post('/api/runs/{run_id}/rejudge')
async def rejudge(jobs: Jobs, run_id: str) -> dict:
    record = store.run(run_id)
    if record is None:
        raise HTTPException(404, 'Прогон не найден')
    return start(jobs, 'rejudge', lambda progress: simulate.rejudge(record, progress))


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


@router.post('/api/review')
async def review(jobs: Jobs, payload: ReviewCommand) -> dict:
    if payload.source == 'log':
        if not payload.dialogueId or not payload.ruleId:
            raise HTTPException(422, 'Нужны dialogueId и ruleId')
        check = answered_check(payload)
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
            raise HTTPException(404, NOT_CHECKED) from error
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
