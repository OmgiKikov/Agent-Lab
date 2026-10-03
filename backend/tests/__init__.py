"""The tests address the app as http://test (httpx base_url). lab.app answers only to this computer's names and to the
ones in LAB_ALLOWED_HOSTS, so the tests name theirs before any request. Discovery (-s tests) does not import this
package; test_app.py sets the same for such a run."""

import os

os.environ.setdefault('LAB_ALLOWED_HOSTS', 'test')
