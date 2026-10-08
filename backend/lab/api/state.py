"""What every screen polls (every 1.5 s during a task): the task, the inputs, each check's result in brief and the
stamps the screens fetch the rest by. Light: no verdicts of a result, no conversation of the export or of a run."""

from fastapi import APIRouter, HTTPException

from .. import agents, models, storage
from ..domain import checks, personas
from ..flows import checks as results_of
from ..flows import connection, inputs, scenarios, tone
from ..jobs import BusyError, view
from . import work
from .base import Jobs

router = APIRouter()

RUN_FIELDS = (
    'id', 'target', 'targetName', 'version', 'label', 'startedAt', 'finishedAt', 'status', 'metric', 'error',
    'model', 'repeats', 'personas', 'updatedAt', 'revision', 'check',
)  # fmt: skip


def source_summary(analysis: dict | None) -> list[dict]:
    """The sources read last, without their texts, with how many criteria of Точность's result each gave."""
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
def state() -> dict:
    """The task is read first, as it stands: it runs on while this answer is put together in a worker thread, and a
    task said to be finished has its data in the same answer (a live state would say «done» beside the data it
    replaced). Each check's result comes in brief (flows.checks.head): the screens fetch its verdicts by its checkId
    and reviewsStamp (GET /api/checks/{check})."""
    task = storage.tasks.latest()
    # Whether starting the same work again continues it (work.continuable): the screen offers to go on.
    job = view(task) | {'continuable': work.continuable(task)}
    found = {check: results_of.head(check) for check in checks.RESULTS}
    return {
        'job': job,
        # The stopped work of each kind that the same start continues (work.paused): its screen offers to go on.
        'paused': work.paused(),
        'model': models.main_model(),
        'models': models.describe(),
        'settings': connection.settings(),
        'sources': source_summary(found[checks.CODE]),
        'sourcesRead': storage.documents.load(inputs.SOURCES_READ),
        'logs': {'total': storage.dialogues.count(), **storage.dialogues.meta()},
        'checks': found,
        # What changes with every answer given, here or in another tab or browser, on a result or a run: the screens
        # fetch the results and the problems again by it, so a case answered elsewhere is never offered again.
        'reviewsStamp': storage.reviews.stamp(),
        'toneOfVoice': storage.documents.load(tone.DRAFT),
        'severity': storage.severity.serious(),
        'severityStamp': storage.severity.stamp(),
        'cards': storage.documents.load(scenarios.DECK),
        'runs': [
            {key: summary.get(key) for key in RUN_FIELDS} | {'targetName': agents.run_name(summary)}
            for summary in storage.runs.summaries()
        ],
        'targets': [agents.public(key, way) for key, way in connection.ways().items()],
        'personas': personas.public(),
    }


@router.post('/api/job/stop')
async def stop_job(jobs: Jobs) -> dict:
    try:
        await jobs.stop()
    except BusyError as error:
        raise HTTPException(409, str(error)) from error
    return {'ok': True}
