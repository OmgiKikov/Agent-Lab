"""What the tests share: the Lab's settings built explicitly (config.Settings), and the app on them.

Discovery (-s tests) imports the test modules by their own names, so they import this one as `support`.
"""

import tempfile
import unittest
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

import httpx

from lab import app, config, storage
from lab.jobs import Jobs, PerAgent
from lab.storage import tasks

# An address nobody answers on: a test that forgets to replace the model gets an error, and no key is ever spent.
NOWHERE = 'http://127.0.0.1:9/v1'


def lab(test: unittest.TestCase, **values: object) -> config.Settings:
    """Settings of the test's own until it ends: a data folder that goes away with it, the models at an address nobody
    answers on, and http://test among the Lab's names. values: what else the test sets, by field."""
    folder = tempfile.TemporaryDirectory()
    test.addCleanup(folder.cleanup)
    fields = {'data': Path(folder.name), 'model_url': NOWHERE, 'allowed_hosts': ['test'], **values}
    return use(test, config.Settings(**fields))


def use(test: unittest.TestCase, settings: config.Settings) -> config.Settings:
    """These settings in force until the test ends."""
    context = config.using(settings)
    context.__enter__()
    test.addCleanup(context.__exit__, None, None, None)
    return settings


def changed(settings: config.Settings, **values: object) -> config.Settings:
    """The same settings with these values, checked as the Lab checks them (a key becomes a secret, a path a path)."""
    return config.Settings.model_validate(settings.model_dump() | values)


def serve(test: unittest.IsolatedAsyncioTestCase, jobs: Jobs | PerAgent | None = None, **values: object) -> None:
    """The Lab's app on settings of the test's own (lab) and a client of it, both closed when the test ends:
    test.settings, test.app, test.client, and test.jobs, the owner of long work (by default one for every agent)."""
    test.settings = lab(test, **values)
    test.app = app.create(test.settings)
    test.jobs = test.app.state.jobs = jobs or Jobs()
    test.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=test.app), base_url='http://test')
    test.addAsyncCleanup(test.client.aclose)
    test.addAsyncCleanup(test.jobs.close)


def exported() -> list[dict]:
    """The conversations of the newest export, [] without one: what a test of one export reads."""
    newest = storage.exports.newest()
    return storage.exports.read(newest['id']) if newest else []


@contextmanager
def running(kind: str) -> Iterator[dict]:
    """A task of this kind kept running while the block runs, as the screens and the guards see one (storage.tasks)."""
    task = tasks.begin(kind, {})
    try:
        yield task
    finally:
        tasks.end(task['id'], tasks.DONE)
