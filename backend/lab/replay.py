"""Replay of exported conversations through the local agent: a step for every customer message, the history taken from
the logs, the agent's trace on every step, a verdict on the new reply (spec 2026-10-05-voice360-replay-design.md)."""

import asyncio
import uuid
from collections.abc import Awaitable, Callable

from . import agents, discover, judge, llm, logs, rag, store, tone
from .agents import AgentError
from .agents.session import session
from .jobs import Progress

RESULT = 'replay.json'
FAMILIES = ('tone', 'code', 'rag')
PARALLEL = 4  # conversations at once, as the simulations (simulate.py); the steps of one go in order
NOT_LOCAL = 'Повтор работает только с локальным агентом: только он отдаёт трейс. Выберите запуск из кода.'
NO_TRACE = 'Агент не отдаёт трейс. Обновите aigw-local: нужен local/agent_lab_trace.py.'
NO_DIALOGUES = 'Нет разговоров для повтора. Сначала загрузите выгрузку.'

StepJudge = Callable[..., Awaitable[judge.Verdict]]


async def run(
    target: str,
    count: int,
    progress: Progress,
    *,
    create: Callable[[str], agents.HttpAgent] = agents.create,
    verdict: StepJudge = judge.step_verdict,
) -> dict:
    """Replay a sample of the exported conversations through the local agent, judge every step and keep the result."""
    dialogues = discover.sample(count)
    if not dialogues:
        raise RuntimeError(NO_DIALOGUES)
    agent = create(target)
    if not agent.mocked:
        raise RuntimeError(NOT_LOCAL)
    progress(done=0, total=0, message='Собираем критерии')
    criteria = await criteria_by_dialogue(dialogues)
    started = store.now()
    plans = [(dialogue, steps(dialogue)) for dialogue in dialogues]
    counter = _Counter(sum(len(planned) for _, planned in plans), progress)
    gate = asyncio.Semaphore(PARALLEL)
    async with session(agent):

        async def one(dialogue: dict, planned: list[dict]) -> dict:
            async with gate:
                rules = criteria[str(dialogue['id'])]
                return await _replay_dialogue(agent, dialogue, planned, rules, verdict, counter)

        try:
            async with asyncio.TaskGroup() as tasks:
                running = [tasks.create_task(one(dialogue, planned)) for dialogue, planned in plans]
        except ExceptionGroup as failed:
            # The job shows the error's words: the group's own are «unhandled errors in a TaskGroup».
            raise _first(failed) from None
    played = [task.result() for task in running]
    value = {
        'id': uuid.uuid4().hex,
        'target': target,
        'version': agent.version,
        'startedAt': started,
        'finishedAt': store.now(),
        'model': llm.models_used([step for d in played for step in d['steps']]),
        'metric': metric(played),
        'dialogues': played,
    }
    store.save(RESULT, value)
    return value


def summary() -> dict | None:
    """What the state says of the latest replay: enough to know it changed."""
    value = store.load(RESULT)
    return {'id': value['id'], 'finishedAt': value['finishedAt']} if value else None


def metric(dialogues: list[dict]) -> dict:
    """PASS / (PASS + FAIL) over the steps' verdicts, per family of criteria."""
    counts = {family: {'pass': 0, 'fail': 0} for family in FAMILIES}
    for row in (row for d in dialogues for step in d['steps'] for row in step.get('rules') or []):
        family = counts.get(row['ruleId'].split(':', 1)[0])
        if family is not None and row['status'] in ('PASS', 'FAIL'):
            family['pass' if row['status'] == 'PASS' else 'fail'] += 1
    return {
        family: {**c, 'accuracy': c['pass'] / (c['pass'] + c['fail']) if c['pass'] + c['fail'] else None}
        for family, c in counts.items()
    }


def dialogue_status(played: list[dict]) -> str:
    statuses = {step.get('status') for step in played}
    if 'FAIL' in statuses:
        return 'FAIL'
    return 'PASS' if statuses == {'PASS'} else 'UNMEASURED'


def steps(dialogue: dict) -> list[dict]:
    """A step for every customer message: the log before it, the message, and production's reply to it, if any."""
    said = [
        {'role': 'customer' if m['role'] == 'user' else 'agent', 'text': m['content']} for m in dialogue['messages']
    ]
    out = []
    for index, message in enumerate(said):
        if message['role'] != 'customer':
            continue
        following = said[index + 1] if index + 1 < len(said) else None
        reply = following['text'] if following and following['role'] == 'agent' else None
        out.append(
            {
                'index': len(out),
                'history': said[:index],
                'customer': message['text'],
                'prodReply': logs.as_seen(reply) if reply is not None else None,
            }
        )
    return out


def of_family(family: str, rules: list[dict]) -> list[dict]:
    """A check's rules under ids of their own family: tone and accuracy number their rules independently."""
    return [{**rule, 'id': f'{family}:{rule["id"]}', 'family': family} for rule in rules]


async def criteria_by_dialogue(dialogues: list[dict]) -> dict[str, list[dict]]:
    """Every dialogue's criteria: tone of voice, its accuracy topic's rules, the knowledge-base ones."""
    tone_rules = _tone_rules()
    accuracy = store.load(discover.RESULT) or {}
    topics = await discover.keep_topics(accuracy, dialogues) if accuracy.get('topics') else []
    topic_of = {dialogue_id: topic for topic in topics for dialogue_id in topic['dialogueIds']}
    return {
        str(d['id']): [
            *tone_rules,
            *of_family('code', (topic_of.get(str(d['id'])) or {}).get('rules') or []),
            *rag.CRITERIA,
        ]
        for d in dialogues
    }


def _tone_rules() -> list[dict]:
    found = tone.rules()
    draft = found[1] if found else None
    return of_family('tone', [tone.for_judging(rule) for rule in draft['criteria']]) if draft else []


class _Counter:
    def __init__(self, total: int, progress: Progress) -> None:
        self.done, self.total, self.progress = 0, total, progress
        progress(done=0, total=total, message='Повторяем разговоры')

    def step_done(self) -> None:
        self.done += 1
        self.progress(done=self.done, total=self.total, message='Повторяем разговоры')


def _first(failed: BaseException) -> BaseException:
    return _first(failed.exceptions[0]) if isinstance(failed, BaseExceptionGroup) else failed


async def _replay_dialogue(
    agent: agents.HttpAgent,
    dialogue: dict,
    planned: list[dict],
    rules: list[dict],
    verdict: StepJudge,
    counter: _Counter,
) -> dict:
    conversation_id = str(uuid.uuid4())
    for step in planned:
        if await _play_step(agent, conversation_id, step):
            await _judge_step(rules, step, verdict)
        counter.step_done()
    return {'dialogueId': str(dialogue['id']), 'status': dialogue_status(planned), 'steps': planned}


async def _play_step(agent: agents.HttpAgent, conversation_id: str, step: dict) -> bool:
    try:
        reply = await agent.say(conversation_id, step['customer'], history=step['history'])
    except AgentError as error:
        step.update(status='UNMEASURED', error=str(error))
        return False
    if reply.get('trace') is None:
        raise RuntimeError(NO_TRACE)
    step['reply'] = {key: reply.get(key) for key in ('text', 'status', 'options', 'seconds')}
    step['trace'] = reply['trace']
    return True


async def _judge_step(rules: list[dict], step: dict, verdict: StepJudge) -> None:
    rag_called = rag.called(step['trace'])
    asked = [rule for rule in rules if rule['family'] != 'rag' or rag_called]
    skipped = [rag.skipped(rule) for rule in rules if rule['family'] == 'rag' and not rag_called]
    if not asked:
        step.update(rules=skipped, status=judge.verdict_of(skipped), error=None)
        return
    try:
        result = await verdict(asked, step)
        second = await judge.second_opinion(verdict, asked, step)
    except llm.ModelError as error:
        step.update(rules=skipped, status='UNMEASURED', error=str(error))
        return
    rows = result.rows + skipped
    step.update(rules=rows, status=judge.verdict_of(rows), model=result.model, second=second, error=None)
