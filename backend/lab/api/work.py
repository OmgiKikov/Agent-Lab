"""Every kind of long work the screens start in the background, by its name: the work done from its stored input, and
for work a stop can leave half done, what makes two starts the same work (its fingerprint), so the same start continues
it. A task is kept with its kind and input (storage.tasks): a Lab started after another one died takes it up again
from them (jobs.recover). A kind not here is work its request awaited, gone with the process: never taken up again."""

import json
from collections.abc import Callable
from dataclasses import dataclass

from fastapi import HTTPException

from .. import storage
from ..flows import accuracy, inputs, launches, scenarios, severity, simulation, tone
from ..jobs import BusyError, PerAgent, Work, view


@dataclass(frozen=True)
class Kind:
    work: Callable[[dict], Work]
    # What makes two starts the same work: a stopped or failed task continues when started again with the same.
    same: Callable[[dict], str] | None = None
    # Lines of work of the kind that never stand for each other (storage.tasks.begin): a stopped one keeps what it
    # did while work of another line runs.
    line: Callable[[dict], object] | None = None


def _launch_line(given: dict) -> object:
    """A launch's line: its check, and whether it checks the recorded answers (the long part a stop leaves half done)
    or only asks the agent again."""
    return [given.get('check'), 'dataset' in (given.get('modes') or ())]


KINDS: dict[str, Kind] = {
    'launch': Kind(lambda given: lambda progress: launches.run(given, progress), launches.fingerprint, _launch_line),
    'tone-check': Kind(
        lambda given: lambda progress: tone.check(
            tone.selection(given['ruleIds'], given['revision']), given['count'], progress, propose=given['propose']
        ),
        tone.fingerprint,
    ),
    'tone-criteria': Kind(lambda given: tone.collect_criteria),
    'discover': Kind(
        lambda given: lambda progress: accuracy.check(
            given['count'], progress, replan=given['replan'], propose=given['propose']
        ),
        accuracy.fingerprint,
    ),
    'run': Kind(
        lambda given: lambda progress: simulation.run(
            given['target'], given['cardIds'], given['label'], progress, given['repeats'], given['personas']
        )
    ),
    'rejudge': Kind(
        lambda given: lambda progress: simulation.rejudge(_run(given['runId']), progress),
        simulation.rejudge_fingerprint,
    ),
    'cards': Kind(lambda given: lambda progress: scenarios.build(given['check'], progress)),
    'sources': Kind(lambda given: lambda progress: inputs.read_code()),
    'severity': Kind(
        lambda given: lambda progress: severity.propose_again(given['check'], progress, again=given['again'])
    ),
}
# What a Lab taking up the tasks a process before it left running needs (jobs.recover).
RESUME: dict[str, Callable[[dict], Work]] = {name: kind.work for name, kind in KINDS.items()}


def start(jobs: PerAgent, kind: str, given: dict, task_id: str | None = None) -> dict:
    """Long work of this kind started in the background with this input, 409 while another task of the agent runs. The
    same work a stop or a failure left continues, with what it kept (continued, kept)."""
    found = KINDS[kind]
    try:
        return jobs.start(
            kind,
            found.work(given),
            given=given,
            fingerprint=found.same(given) if found.same else None,
            task_id=task_id,
            line=found.line,
        )
    except BusyError as error:
        raise HTTPException(409, str(error)) from error


def continuable(task: dict | None) -> bool:
    """Whether starting the task's work again now continues it: it stopped or failed with finished parts kept, it is
    the latest of its line of work (storage.tasks.begin), and its work is still the same (the materials, the criteria
    and the models have not changed since)."""
    if task is None:
        return False
    kind = KINDS.get(task['kind'])
    if kind is None or (kind.line is not None and task['id'] not in _latest_by_line(task['kind'])):
        return False
    return _still_the_same(kind, task)


def _still_the_same(kind: Kind, task: dict) -> bool:
    if task['status'] not in (storage.tasks.STOPPED, storage.tasks.FAILED) or not task['kept'] or kind.same is None:
        return False
    try:
        return kind.same(task['input']) == task['fingerprint']
    except (KeyError, ValueError):  # the materials it was made of are gone
        return False


def _latest_by_line(name: str) -> dict[str, dict]:
    """The task started last of each line of a kind of work, by its line, the latest line first."""
    line = KINDS[name].line
    latest: dict[str, dict] = {}
    for task in storage.tasks.of_kind(name):
        latest.setdefault(json.dumps(line(task['input']) if line else None, ensure_ascii=False), task)
    return {task['id']: task for task in latest.values()}


def paused() -> dict[str, dict]:
    """The stopped or failed work of each kind that the same start would continue now (continuable), as the screens
    read a task: a screen offers to go on with it whatever other task ran after it. Of a kind with lines of work, the
    latest such task of any line."""
    found = {}
    for name, kind in KINDS.items():
        if kind.same is None:
            continue
        candidates = _latest_by_line(name).values() if kind.line else [storage.tasks.latest(name)]
        task = next((t for t in candidates if t and _still_the_same(kind, t)), None)
        if task:
            found[name] = view(task)
    return found


def _run(run_id: str) -> dict:
    record = storage.runs.get(run_id)
    if record is None:
        raise RuntimeError('Прогон не найден')
    return record
