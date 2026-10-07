"""Replay of exported conversations through an agent that gives its trace (the local one, the replay service on the
stand): a step for every customer message, the history taken from the logs, the agent's trace on every step, a verdict
on the new reply (spec 2026-10-05-voice360-replay-design.md).

A replay is made by a task and keeps, as steps of it (storage.tasks), its criteria and every conversation as soon as it
is replayed and judged: the same replay started again after a stop or a restart (fingerprint) replays only the rest.
The latest replay is kept as a document, with a small one beside it that the state polled every 1.5 s reads.
"""

import asyncio
import uuid
from collections.abc import Awaitable, Callable, Iterable

from .. import agents, models, storage
from ..domain import export, match, rag, verdicts
from ..domain.tone import for_judging
from ..roles import judge
from . import Progress, accuracy, connection, conversations, same_work, tone
from .simulation import PARALLEL

RESULT = 'replay.json'
# What the state polled every 1.5 s says of the latest replay: read instead of the whole RESULT.
REPLAY_SUMMARY = 'replay-summary.json'
CRITERIA = 'criteria'  # the step a replay's criteria are kept under: a replay continued judges by the same
FAMILIES = ('tone', 'code', 'rag')
NOT_TRACED = 'Повтор работает с агентом, который отдаёт трейс: на этом компьютере или сервисом повтора на стенде.'
NO_TRACE = 'Агент не отдаёт трейс. Обновите aigw-local: нужен replay/recorder.py.'
STEP_WITHOUT_TRACE = 'Агент не отдал трейс этого шага.'
NO_DIALOGUES = 'Нет разговоров для повтора. Сначала загрузите выгрузку.'

StepJudge = Callable[..., Awaitable[judge.Verdict]]


async def run(
    target: str,
    count: int,
    progress: Progress,
    *,
    create: Callable[[str], agents.Agent] = connection.connect,
    verdict: StepJudge = judge.step_verdict,
) -> dict:
    """Replay a sample of the exported conversations through the agent, judge every step and keep the result."""
    dialogues = conversations.sample(count)
    if not dialogues:
        raise RuntimeError(NO_DIALOGUES)
    agent = create(target)
    if not agent.traced:
        raise RuntimeError(NOT_TRACED)
    kept = storage.tasks.steps()
    async with agents.session(agent):
        progress(done=0, total=0, message='Собираем критерии')
        planned = kept.get(CRITERIA)
        if planned is None:
            criteria = await criteria_by_dialogue(dialogues)
            planned = storage.tasks.keep(CRITERIA, {'startedAt': storage.now(), 'criteria': criteria})
        criteria = planned['criteria']
        plans = [(dialogue, steps(dialogue)) for dialogue in dialogues]
        before = {str(d['id']): kept[_step(d['id'])] for d in dialogues if _step(d['id']) in kept}
        replaying = _Replaying(sum(len(steps_of) for _, steps_of in plans), progress, before.values())
        gate = asyncio.Semaphore(PARALLEL)

        async def one(dialogue: dict, steps_of: list[dict]) -> dict:
            found = before.get(str(dialogue['id']))
            if found is not None:
                return found
            async with gate:
                rules = criteria[str(dialogue['id'])]
                played = await _replay_dialogue(agent, dialogue, steps_of, rules, verdict, replaying)
            return storage.tasks.keep(_step(dialogue['id']), played)

        try:
            async with asyncio.TaskGroup() as tasks:
                running = [tasks.create_task(one(dialogue, steps_of)) for dialogue, steps_of in plans]
        except ExceptionGroup as failed:
            # The job shows the error's words: the group's own are «unhandled errors in a TaskGroup».
            raise _first(failed) from None
    played = [task.result() for task in running]
    value = {
        'id': uuid.uuid4().hex,
        'target': target,
        'version': agent.version,
        'stand': getattr(agent, 'stand', None),
        'startedAt': planned['startedAt'],
        'finishedAt': storage.now(),
        'model': models.models_used([step for d in played for step in d['steps']]),
        'metric': metric(played),
        'dialogues': played,
    }
    with storage.transaction():
        storage.documents.save(RESULT, value)
        storage.documents.save(REPLAY_SUMMARY, {'id': value['id'], 'finishedAt': value['finishedAt']})
    return value


def fingerprint(given: dict) -> str:
    """The same replay (api/work.KINDS): through the same way to the agent, by the same criteria (tone of voice's
    revision, Точность's check), of the same sample of the same export, by the same judges."""
    tone_draft = storage.documents.load(tone.DRAFT) or {}
    code = storage.documents.load(accuracy.RESULT) or {}
    return same_work(
        replay=given['target'],
        tone=tone_draft.get('revision'),
        code=code.get('checkId') or code.get('startedAt'),
        **conversations.same_material(given['count']),
    )


def summary() -> dict | None:
    """What the state says of the latest replay: enough to know it changed."""
    return storage.documents.load(REPLAY_SUMMARY)


def shown() -> dict:
    """The latest replay and what it says about the knowledge base, counted on every read from the saved verdicts;
    empty before the first replay."""
    result = storage.documents.load(RESULT)
    if not result:
        return {}
    return {**result, 'knowledgeBase': rag.summary(result.get('dialogues') or [])}


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
                'prodReply': export.as_seen(reply) if reply is not None else None,
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
    found = storage.documents.load(accuracy.RESULT) or {}
    topics = await accuracy.keep_topics(found, dialogues) if found.get('topics') else []
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
    return of_family('tone', [for_judging(rule) for rule in draft['criteria']]) if draft else []


def _step(dialogue_id: object) -> str:
    """The step a replayed conversation is kept under in its task."""
    return f'dialogue:{dialogue_id}'


def _family_verdicts(rows: list[dict]) -> dict[str, str]:
    """A step's verdict per family: FAIL by any failed row of it, PASS by a passed one; a family with neither is left
    out."""
    found: dict[str, str] = {}
    for row in rows:
        if row['status'] not in ('PASS', 'FAIL'):
            continue
        family = row['ruleId'].split(':', 1)[0]
        if found.get(family) != 'FAIL':
            found[family] = row['status']
    return found


class _Replaying:
    """What the dialogues replayed at once share: the steps done, and whether the agent has given any step its trace.
    A replay continued starts from the conversations it kept (before)."""

    def __init__(self, total: int, progress: Progress, before: Iterable[dict] = ()) -> None:
        kept = [step for dialogue in before for step in dialogue['steps']]
        self.done, self.total, self.progress = len(kept), total, progress
        self.traced = any(step.get('trace') is not None for step in kept)
        progress(done=self.done, total=total, message='Повторяем разговоры')

    def step_done(self) -> None:
        self.done += 1
        self.progress(done=self.done, total=self.total, message='Повторяем разговоры')


def _first(failed: BaseException) -> BaseException:
    return _first(failed.exceptions[0]) if isinstance(failed, BaseExceptionGroup) else failed


async def _replay_dialogue(
    agent: agents.Agent,
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


async def _play_step(agent: agents.Agent, conversation_id: str, step: dict, replaying: _Replaying) -> bool:
    try:
        reply = await agent.say(conversation_id, step['customer'], history=step['history'])
    except agents.AgentError as error:
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
        step.update(rules=skipped, status=verdicts.step_status(skipped), error=None)
        return
    try:
        result, second = await _both_judges(asked, step, verdict)
    except models.ModelError as error:
        step.update(rules=verdicts.checked([], asked, '') + skipped, status='UNMEASURED', error=str(error))
        return
    rows = result.rows + skipped
    step.update(rules=rows, status=verdicts.step_status(rows), model=result.model, second=second, error=None)


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
    """The judge's verdict and the second judge's, asked at once as a run's conversation is (simulation.evaluate)."""
    try:
        async with asyncio.TaskGroup() as tasks:
            primary = tasks.create_task(verdict(asked, step))
            secondary = tasks.create_task(judge.second_opinion(verdict, asked, step))
    except* models.ModelError as errors:
        raise models.ModelError(str(errors.exceptions[0])) from errors
    return primary.result(), secondary.result()
