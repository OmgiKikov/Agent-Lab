"""Replay of exported conversations through the local agent: a step for every customer message, the history taken from
the logs, the agent's trace on every step, a verdict on the new reply (spec 2026-10-05-voice360-replay-design.md)."""

import asyncio
import uuid
from collections.abc import Awaitable, Callable

from . import agents, discover, judge, llm, logs, match, rag, store, tone
from .agents import AgentError
from .agents.session import session
from .jobs import Progress
from .simulate import PARALLEL

RESULT = 'replay.json'
# What the state polled every 1.5 s says of the latest replay: read instead of the whole RESULT.
REPLAY_SUMMARY = 'replay-summary.json'
FAMILIES = ('tone', 'code', 'rag')
NOT_LOCAL = 'Повтор работает только с локальным агентом: только он отдаёт трейс. Выберите запуск из кода.'
NO_TRACE = 'Агент не отдаёт трейс. Обновите aigw-local: нужен local/agent_lab_trace.py.'
STEP_WITHOUT_TRACE = 'Агент не отдал трейс этого шага.'
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
    replaying = _Replaying(sum(len(planned) for _, planned in plans), progress)
    gate = asyncio.Semaphore(PARALLEL)
    async with session(agent):

        async def one(dialogue: dict, planned: list[dict]) -> dict:
            async with gate:
                rules = criteria[str(dialogue['id'])]
                return await _replay_dialogue(agent, dialogue, planned, rules, verdict, replaying)

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
    store.save(REPLAY_SUMMARY, {'id': value['id'], 'finishedAt': value['finishedAt']})
    return value


def summary() -> dict | None:
    """What the state says of the latest replay: enough to know it changed."""
    return store.load(REPLAY_SUMMARY)


def metric(dialogues: list[dict]) -> dict:
    """PASS / (PASS + FAIL) over the steps, per family of criteria: a step counts once in a family, failed by any of
    the family's failed rules."""
    counts = {family: {'pass': 0, 'fail': 0} for family in FAMILIES}
    for step in (step for d in dialogues for step in d['steps']):
        for family, status in _family_verdicts(step.get('rules') or []).items():
            if family in counts:
                counts[family]['pass' if status == 'PASS' else 'fail'] += 1
    return {
        family: {**c, 'accuracy': c['pass'] / (c['pass'] + c['fail']) if c['pass'] + c['fail'] else None}
        for family, c in counts.items()
    }


def dialogue_status(played: list[dict]) -> str:
    """FAIL if a step failed; PASS if a step passed; UNMEASURED if no step was measured."""
    statuses = {step.get('status') for step in played}
    if 'FAIL' in statuses:
        return 'FAIL'
    return 'PASS' if 'PASS' in statuses else 'UNMEASURED'


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
    """Every dialogue's criteria: tone of voice, its accuracy topic's rules, the knowledge-base ones and the match with
    production."""
    tone_rules = _tone_rules()
    accuracy = store.load(discover.RESULT) or {}
    topics = await discover.keep_topics(accuracy, dialogues) if accuracy.get('topics') else []
    topic_of = {dialogue_id: topic for topic in topics for dialogue_id in topic['dialogueIds']}
    return {
        str(d['id']): [
            *tone_rules,
            *of_family('code', (topic_of.get(str(d['id'])) or {}).get('rules') or []),
            *rag.CRITERIA,
            match.CRITERION,
        ]
        for d in dialogues
    }


def _tone_rules() -> list[dict]:
    found = tone.rules()
    draft = found[1] if found else None
    return of_family('tone', [tone.for_judging(rule) for rule in draft['criteria']]) if draft else []


def _family_verdicts(rows: list[dict]) -> dict[str, str]:
    """A step's verdict per family: FAIL by any failed row of it, PASS by a passed one; a family with neither is left
    out."""
    verdicts: dict[str, str] = {}
    for row in rows:
        if row['status'] not in ('PASS', 'FAIL'):
            continue
        family = row['ruleId'].split(':', 1)[0]
        if verdicts.get(family) != 'FAIL':
            verdicts[family] = row['status']
    return verdicts


class _Replaying:
    """What the dialogues replayed at once share: the steps done, and whether the agent has given any step its trace."""

    def __init__(self, total: int, progress: Progress) -> None:
        self.done, self.total, self.progress = 0, total, progress
        self.traced = False
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
    replaying: _Replaying,
) -> dict:
    conversation_id = str(uuid.uuid4())
    for step in planned:
        if await _play_step(agent, conversation_id, step, replaying):
            await _judge_step(rules, step, verdict)
        replaying.step_done()
    return {'dialogueId': str(dialogue['id']), 'status': dialogue_status(planned), 'steps': planned}


async def _play_step(agent: agents.HttpAgent, conversation_id: str, step: dict, replaying: _Replaying) -> bool:
    try:
        reply = await agent.say(conversation_id, step['customer'], history=step['history'])
    except AgentError as error:
        step.update(status='UNMEASURED', error=str(error))
        return False
    step['reply'] = {key: reply.get(key) for key in ('text', 'status', 'options', 'seconds')}
    if reply.get('trace') is None:
        # Before any trace the agent most likely cannot give one at all; after, only this step lost its trace.
        if not replaying.traced:
            raise RuntimeError(NO_TRACE)
        step.update(status='UNMEASURED', error=STEP_WITHOUT_TRACE)
        return False
    replaying.traced = True
    step['trace'] = reply['trace']
    return True


async def _judge_step(rules: list[dict], step: dict, verdict: StepJudge) -> None:
    asked, skipped = _split(rules, step)
    if not asked:
        step.update(rules=skipped, status=judge.step_status(skipped), error=None)
        return
    try:
        result, second = await _both_judges(asked, step, verdict)
    except llm.ModelError as error:
        step.update(rules=judge.checked([], asked, '') + skipped, status='UNMEASURED', error=str(error))
        return
    rows = result.rows + skipped
    step.update(rules=rows, status=judge.step_status(rows), model=result.model, second=second, error=None)


def _split(rules: list[dict], step: dict) -> tuple[list[dict], list[dict]]:
    """The rules to ask the judge about, and the rows of those whose moment did not arise on this step."""
    rag_called = rag.called(step['trace'])
    asked, skipped = [], []
    for rule in rules:
        if rule['family'] == 'rag' and not rag_called:
            skipped.append(rag.skipped(rule))
        elif rule['family'] == match.FAMILY and step.get('prodReply') is None:
            skipped.append(match.skipped())
        else:
            asked.append(rule)
    return asked, skipped


async def _both_judges(asked: list[dict], step: dict, verdict: StepJudge) -> tuple[judge.Verdict, dict | None]:
    """The judge's verdict and the second judge's, asked at once as judge.evaluate does."""
    try:
        async with asyncio.TaskGroup() as tasks:
            primary = tasks.create_task(verdict(asked, step))
            secondary = tasks.create_task(judge.second_opinion(verdict, asked, step))
    except* llm.ModelError as errors:
        raise llm.ModelError(str(errors.exceptions[0])) from errors
    return primary.result(), secondary.result()
