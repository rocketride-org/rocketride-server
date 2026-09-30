# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================

"""
Passthrough `requests` shadow, faking only third-party HTTP endpoints that
this test harness has no other way to mock.

Why this exists
----------------
Every other entry in `nodes/test/mocks/` shadows an *SDK package* (openai,
anthropic, qdrant_client, ...) -- see `nodes/test/mocks/__init__.py`. That
works for nodes that call a vendor SDK, but breaks down for a node like
`cloud_stt` (Deepgram) that calls the vendor's REST API directly with
`requests.post(...)` and no SDK at all: there is no vendor-specific package to
shadow. `tool_gohighlevel` and `tool_pipedrive` are two other raw-`requests`
callers with the same gap -- neither has a mock-backed dynamic node-service
test either -- though both call `requests.request(...)`, not `requests.post`,
so this module's `post`-only override does not reach them yet (see "Adding a
new endpoint" below). `tool_slack` is not in this category: it goes through
`slack_sdk`, not raw `requests`, and already has an SDK to shadow like every
other entry in `nodes/test/mocks/`. There is also no
`responses`/`requests-mock`/`respx` dependency in this repo to build one from.

This module is the missing piece: it shadows the `requests` package itself
(the only thing actually common to every raw-HTTP node), but unlike an SDK
mock it does NOT stub the whole library -- it loads and re-exports the REAL
`requests` package as a passthrough baseline, then overrides only `post()` to
intercept the one URL a given node's mock test cares about (Deepgram's
`/v1/listen` here) and fall through to the real implementation for anything
else. `request()`, `get()`, `put()`, `patch()`, `delete()`, and every
`Session` method are re-exported straight from the real package and are not
interceptable yet -- a node that calls `requests.request(...)` or uses a
`Session` needs that overridden first. That passthrough design is what makes
it safe to add as shared, repo-wide infrastructure: any other node's
subprocess that happens to import `requests` under ROCKETRIDE_MOCK (for real,
unrelated reasons) still gets real network behavior for every URL except the
ones a mock module here explicitly claims -- pinned by
`TestRequestsShadowPassthrough` in `nodes/test/cloud_stt/test_cloud_stt.py`,
the one node currently importing this shadow.

Why this can't leak into the live/gated test
---------------------------------------------
`cloud_stt`'s Deepgram service.json has two "test" groups: this ungated one
(runs whenever ROCKETRIDE_MOCK is set, which the CI test runner sets globally
for every dynamic node test -- see nodes/scripts/tasks.js) and the pre-existing
`avoidMocks: true` group gated on a real `ROCKETRIDE_STT_DEEPGRAM_KEY`.
`avoidMocks: true` on a pipeline makes `task_engine.py` (search
"avoidMocks: strip ROCKETRIDE_MOCK") strip ROCKETRIDE_MOCK from that specific
pipeline's spawned subprocess env before it starts -- so the live group's
subprocess never even sees this mock directory on sys.path, and this module
never loads there. Only the ungated group's subprocess does.

Adding a new endpoint
----------------------
For a node that calls `requests.post(...)` directly: add a case the same way
`post()` below does -- match the exact URL (or a narrow, defensive prefix
match), validate whatever request shape you actually care about, and fall
through to `_real.post(...)` for everything else.

For a node that calls `requests.request(...)`, uses a `Session`, or calls
`get`/`put`/`patch`/`delete`, this module has nothing to intercept yet:
override `request(method, url, *a, **kw)` the same way `post()` does, with
`post`/`get`/... becoming thin wrappers over it.
"""

import importlib.machinery
import importlib.util
import os
import sys

# nodes/test/mocks -- the directory ROCKETRIDE_MOCK points sys.path at. Excluded
# below when locating the real `requests` package so we don't just re-import
# this shadow (see _load_real_requests).
_MOCK_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _load_real_requests():
    """Load the actual installed `requests` package under its own identity.

    `importlib.machinery.PathFinder.find_spec` is given sys.path with
    `_MOCK_ROOT` filtered out, so it finds the real, installed distribution
    instead of this shadow package. `requests/__init__.py` does its own
    internal `import requests.exceptions` / `import requests.models` etc.,
    which look up `sys.modules['requests']` mid-import -- so that key is
    pointed at the new (empty, about-to-be-executed) real module object for
    the duration of `exec_module`, then restored to whatever it was
    (this shadow module, mid-import from the caller's `import requests`)
    once the real package has finished initializing.
    """
    search_path = [p for p in sys.path if os.path.abspath(p or '.') != _MOCK_ROOT]
    spec = importlib.machinery.PathFinder.find_spec('requests', path=search_path)
    if spec is None or spec.loader is None:
        raise ImportError(
            'mock `requests` shadow (nodes/test/mocks/requests): could not locate the '
            'real, installed requests package on sys.path with the mock dir excluded.'
        )
    real_requests = importlib.util.module_from_spec(spec)
    previous = sys.modules.get('requests')
    sys.modules['requests'] = real_requests
    try:
        spec.loader.exec_module(real_requests)
    finally:
        if previous is not None:
            sys.modules['requests'] = previous
        else:
            sys.modules.pop('requests', None)
    return real_requests


_real = _load_real_requests()

# Re-export the real package's full public surface as the passthrough
# baseline (Session, exceptions, models, get/put/delete/..., codes, ...) so
# anything this shadow doesn't explicitly override behaves identically to the
# real library.
for _name in dir(_real):
    if not _name.startswith('_'):
        globals()[_name] = getattr(_real, _name)
del _name

# -----------------------------------------------------------------------
# Deepgram /v1/listen (cloud_stt) -- the only endpoint this shadow fakes.
# -----------------------------------------------------------------------

_DEEPGRAM_LISTEN_URL = 'https://api.deepgram.com/v1/listen'
_MOCK_TRANSCRIPT = 'Mock Deepgram transcript for RocketRide node tests.'


def _fake_deepgram_response(headers, data):
    """Validate the outgoing request shape and build a realistic Deepgram
    /v1/listen success body, using a REAL `requests.Response` (not a bare
    stand-in) so `.raise_for_status()` / `.json()` behave exactly as
    production code expects.
    """
    auth = (headers or {}).get('Authorization', '')
    if not auth.startswith('Token '):
        raise AssertionError(
            f"mock Deepgram endpoint: expected 'Authorization: Token <key>', got {auth!r} "
            "-- deepgram_stt.py's auth header shape changed; update this mock or fix the regression."
        )
    content_type = (headers or {}).get('Content-Type')
    if not content_type:
        raise AssertionError('mock Deepgram endpoint: request is missing a Content-Type header')
    if not data:
        raise AssertionError('mock Deepgram endpoint: request body (audio bytes) is empty')

    import json

    body = {
        'results': {
            'channels': [
                {
                    'alternatives': [
                        {
                            'transcript': _MOCK_TRANSCRIPT,
                            'confidence': 0.99,
                        }
                    ]
                }
            ]
        }
    }
    resp = _real.models.Response()
    resp.status_code = 200
    resp.headers['Content-Type'] = 'application/json'
    resp._content = json.dumps(body).encode('utf-8')
    resp.url = _DEEPGRAM_LISTEN_URL
    return resp


def post(url, *args, **kwargs):
    """Passthrough `requests.post`, faking only Deepgram's listen endpoint.

    Positional args mirror `requests.post(url, data=None, json=None, **kwargs)`
    -- `deepgram_stt.py` calls with everything as keywords (`params=`,
    `headers=`, `data=`, `timeout=`), so both are accepted for fidelity with
    the real signature without needing to replicate it exactly.
    """
    if url == _DEEPGRAM_LISTEN_URL:
        return _fake_deepgram_response(kwargs.get('headers'), kwargs.get('data'))
    return _real.post(url, *args, **kwargs)
