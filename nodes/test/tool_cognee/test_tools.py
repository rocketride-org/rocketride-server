# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Unit tests for the tool_cognee node.

Pure-Python: no server, no engine, no real HTTP. The node module is imported
under composable stubs for ``rocketlib`` and ``ai.common.*`` so the relative
imports resolve without the engine runtime. Tool methods are tested by patching
the ``cognee_client`` helper functions; the client's own HTTP layer is exercised
only for the pure response/error shaping helpers and key redaction (with
``requests`` patched to raise).

Covers:
* ``cognee_client`` pure helpers — ``_headers``, ``_shape_run``,
  ``_shape_results``, ``_find_dataset_id``, ``_as_runtime_error`` redaction.
* ``cognee_client.reset`` network-level behavior — the GET/DELETE dataset
  lifecycle via a stubbed ``requests.request``, including the 404-as-not_found
  delete-race handling and key redaction on transport/HTTP failures.
* ``add`` / ``cognify`` / ``search`` / ``reset`` — input validation, dataset
  and default fallbacks, per-call overrides, delegation args, raise-on-error.
"""

from __future__ import annotations

import importlib
import sys
import types
from pathlib import Path

import pytest

_NODE_DIR = Path(__file__).resolve().parent.parent.parent / 'src' / 'nodes' / 'tool_cognee'


# ---------------------------------------------------------------------------
# Composable import scaffolding (augments existing stubs, never clobbers)
# ---------------------------------------------------------------------------


def _tool_function(**_meta):
    """Stub @tool_function decorator that records metadata and returns the function."""

    def wrap(fn):
        """Attach tool metadata to the wrapped function and return it."""
        fn.__tool_meta__ = _meta
        return fn

    return wrap


def _ensure_rocketlib() -> None:
    """Install a minimal rocketlib stub so the node imports without the engine."""
    mod = sys.modules.get('rocketlib') or types.ModuleType('rocketlib')
    if not hasattr(mod, 'IInstanceBase'):
        mod.IInstanceBase = type('IInstanceBase', (), {})
    if not hasattr(mod, 'IGlobalBase'):
        mod.IGlobalBase = type('IGlobalBase', (), {})
    if not hasattr(mod, 'tool_function'):
        mod.tool_function = _tool_function
    if not hasattr(mod, 'OPEN_MODE'):
        mod.OPEN_MODE = type('OPEN_MODE', (), {'CONFIG': 'config'})
    for name in ('debug', 'error', 'warning'):
        if not hasattr(mod, name):
            setattr(mod, name, lambda *a, **k: None)
    sys.modules['rocketlib'] = mod


def _passthrough(args, tool_name=None):
    """Identity stand-in for normalize_tool_input (returns dict args unchanged)."""
    return args if isinstance(args, dict) else {}


def _ensure_ai_common() -> None:
    """Create minimal ``ai.common.*`` stubs only when absent (never overwrite)."""
    for name in ('ai', 'ai.common', 'ai.common.utils', 'ai.common.config'):
        if name not in sys.modules:
            sys.modules[name] = types.ModuleType(name)
    utils = sys.modules['ai.common.utils']
    if not hasattr(utils, 'normalize_tool_input'):
        utils.normalize_tool_input = _passthrough
    if not hasattr(utils, 'post_with_retry'):
        utils.post_with_retry = lambda *a, **k: None
    if not hasattr(sys.modules['ai.common.config'], 'Config'):

        class _Config:
            """Minimal Config stub returning an empty node config."""

            @staticmethod
            def getNodeConfig(*_a, **_k):
                """Return an empty config dict."""
                return {}

        sys.modules['ai.common.config'].Config = _Config


def _ensure_requests() -> None:
    """Stub ``requests`` if unavailable — the HTTP layer is patched out anyway."""
    if 'requests' in sys.modules:
        return
    mod = types.ModuleType('requests')
    mod.RequestException = type('RequestException', (Exception,), {})
    exc = types.ModuleType('requests.exceptions')
    exc.Timeout = type('Timeout', (mod.RequestException,), {})
    exc.HTTPError = type('HTTPError', (mod.RequestException,), {})
    exc.ConnectionError = type('ConnectionError', (mod.RequestException,), {})
    mod.exceptions = exc
    mod.post = lambda *a, **k: None
    mod.get = lambda *a, **k: None
    mod.delete = lambda *a, **k: None
    mod.Response = type('Response', (), {})
    sys.modules['requests'] = mod
    sys.modules['requests.exceptions'] = exc


def _ensure_tenacity() -> None:
    """Stub ``tenacity`` if unavailable — not used directly by the node module."""
    if 'tenacity' in sys.modules:
        return
    mod = types.ModuleType('tenacity')
    mod.Retrying = lambda **_kw: lambda fn, *a, **k: fn(*a, **k)
    mod.stop_after_attempt = lambda *a, **k: None
    mod.wait_exponential = lambda *a, **k: None
    mod.retry_if_exception = lambda *a, **k: None
    sys.modules['tenacity'] = mod


def _ensure_pkg() -> None:
    """Register a tool_cognee package pointing at the node source directory."""
    if 'tool_cognee' not in sys.modules:
        pkg = types.ModuleType('tool_cognee')
        pkg.__path__ = [str(_NODE_DIR)]
        sys.modules['tool_cognee'] = pkg


_ensure_rocketlib()
_ensure_ai_common()
_ensure_requests()
_ensure_tenacity()
_ensure_pkg()

import requests  # noqa: E402

from tool_cognee import cognee_client as client  # noqa: E402
from tool_cognee import IInstance as IInstanceMod  # noqa: E402
from tool_cognee.IInstance import IInstance  # noqa: E402
from tool_cognee.IGlobal import IGlobal  # noqa: E402


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _pin_normalizer(monkeypatch):
    """Pin the input normalizer to a passthrough per test (scoped + auto-restored)."""
    monkeypatch.setattr(IInstanceMod, 'normalize_tool_input', _passthrough)


def _make_global(**overrides):
    """Build an IGlobal preset with test config."""
    glb = IGlobal()
    glb.base_url = 'http://localhost:8000'
    glb.api_key = 'ck_test'
    glb.dataset = 'main'
    glb.search_type = 'GRAPH_COMPLETION'
    glb.top_k = 15
    glb.request_timeout = 120
    for k, v in overrides.items():
        setattr(glb, k, v)
    return glb


def _instance(glb):
    """Construct an IInstance bound to the given IGlobal."""
    inst = IInstance()
    inst.IGlobal = glb
    return inst


@pytest.fixture
def captured(monkeypatch):
    """Patch the cognee_client helpers, recording call kwargs and returning canned data."""
    state = {'calls': [], 'add': {'status': 'ok'}, 'cognify': {'status': 'ok'}, 'search': [], 'reset': {}}

    def _record(name, canned_key):
        def fake(base_url, api_key, **kwargs):
            state['calls'].append({'name': name, 'base_url': base_url, 'api_key': api_key, 'kwargs': kwargs})
            return state[canned_key]

        return fake

    monkeypatch.setattr(client, 'add', _record('add', 'add'))
    monkeypatch.setattr(client, 'cognify', _record('cognify', 'cognify'))
    monkeypatch.setattr(client, 'search', _record('search', 'search'))
    monkeypatch.setattr(client, 'reset', _record('reset', 'reset'))
    return state


# ---------------------------------------------------------------------------
# cognee_client pure helpers
# ---------------------------------------------------------------------------


def test_headers_include_key_only_when_set():
    """X-Api-Key is sent only when a key is configured; accept is always present."""
    assert client._headers('ck_x') == {'accept': 'application/json', 'X-Api-Key': 'ck_x'}
    assert client._headers('') == {'accept': 'application/json'}


def test_shape_run_variants():
    """Run shaping: direct run object, cognify's dataset-keyed map, and empty."""
    direct = client._shape_run({'pipeline_run_id': 'r1', 'status': 'DONE'}, 'main')
    assert direct == {'dataset': 'main', 'status': 'DONE', 'pipeline_run_id': 'r1'}
    # cognify returns {dataset: PipelineRunInfo} — first entry is unwrapped.
    keyed = client._shape_run({'main': {'pipeline_run_id': 'r2', 'status': 'RUNNING'}}, 'main')
    assert keyed['pipeline_run_id'] == 'r2' and keyed['status'] == 'RUNNING'
    # run_id alias and empty body default to a safe status.
    assert client._shape_run({'run_id': 'r3'}, 'main')['pipeline_run_id'] == 'r3'
    assert client._shape_run({}, 'main') == {'dataset': 'main', 'status': 'ok', 'pipeline_run_id': ''}


def test_shape_results_variants():
    """Results shaping: dict rows pass through, string rows wrap, wrappers/None tolerated."""
    rows = client._shape_results([{'id': 'c1', 'text': 'chunk'}, 'a plain answer'])
    assert rows[0] == {'id': 'c1', 'text': 'chunk'}
    assert rows[1] == {'text': 'a plain answer'}
    assert client._shape_results({'results': [{'id': 'c2'}]})[0]['id'] == 'c2'
    assert client._shape_results(None) == []
    assert client._shape_results({'results': []}) == []


def test_find_dataset_id_variants():
    """Dataset id resolved by exact name; wrapper and misses tolerated."""
    rows = [{'id': 'u1', 'name': 'other'}, {'id': 'u2', 'name': 'main'}]
    assert client._find_dataset_id(rows, 'main') == 'u2'
    assert client._find_dataset_id({'datasets': rows}, 'other') == 'u1'
    assert client._find_dataset_id(rows, 'missing') == ''
    assert client._find_dataset_id(None, 'main') == ''


def test_runtime_error_redacts_and_formats():
    """The error helper never carries the key and includes the HTTP status when present."""
    err = client._as_runtime_error(requests.exceptions.Timeout(), 'search')
    assert isinstance(err, RuntimeError)
    assert 'search request failed' in str(err) and 'Timeout' in str(err)


def test_add_error_never_leaks_key(monkeypatch):
    """A failing add raises RuntimeError whose message never contains the API key."""

    def boom(*a, **k):
        raise requests.exceptions.ConnectionError('connect failed')

    monkeypatch.setattr(client.requests, 'post', boom)
    with pytest.raises(RuntimeError) as ei:
        client.add('http://localhost:8000', 'ck_supersecret', text='hi', dataset='main', timeout=5)
    assert 'ck_supersecret' not in str(ei.value)


# ---------------------------------------------------------------------------
# cognee_client.reset — retry-wrapped GET/DELETE against a stubbed requests.request
# ---------------------------------------------------------------------------


class _FakeResponse:
    """Minimal ``requests.Response`` stand-in: status_code, json(), raise_for_status()."""

    def __init__(self, status_code=200, payload=None, *, content=b'{}', headers=None):
        self.status_code = status_code
        self._payload = {} if payload is None else payload
        self.content = content
        self.headers = {} if headers is None else headers

    def json(self):
        """Return the canned JSON payload."""
        return self._payload

    def raise_for_status(self):
        """Raise HTTPError with ``.response`` set, mirroring real requests behavior."""
        if self.status_code >= 400:
            err = requests.exceptions.HTTPError(f'{self.status_code} error')
            err.response = self
            raise err


def _stub_request(monkeypatch, *, get=None, get_exc=None, delete=None, delete_exc=None):
    """Stub ``requests.request`` (what ``_request_with_retry`` calls) by HTTP method.

    Returns the list of recorded calls so tests can assert whether DELETE happened.
    """
    calls = []

    def fake(method, url, *, headers, timeout):
        calls.append({'method': method, 'url': url})
        if method == 'GET':
            if get_exc is not None:
                raise get_exc
            resp = get
        elif method == 'DELETE':
            if delete_exc is not None:
                raise delete_exc
            resp = delete
        else:
            raise AssertionError(f'unexpected method {method}')
        resp.raise_for_status()
        return resp

    monkeypatch.setattr(client.requests, 'request', fake, raising=False)
    return calls


def test_reset_client_dataset_missing_skips_delete(monkeypatch):
    """Dataset absent from the list -> not_found, deleted False, DELETE never called."""
    calls = _stub_request(monkeypatch, get=_FakeResponse(200, {'datasets': [{'id': 'u1', 'name': 'other'}]}))
    out = client.reset('http://localhost:8000', 'ck_test', dataset='main', timeout=5)
    assert out == {'dataset': 'main', 'status': 'not_found', 'deleted': False}
    assert [c['method'] for c in calls] == ['GET']


def test_reset_client_happy_path(monkeypatch):
    """GET lists the dataset, DELETE 2xx -> status='reset', deleted=True."""
    calls = _stub_request(
        monkeypatch,
        get=_FakeResponse(200, {'datasets': [{'id': 'u2', 'name': 'main'}]}),
        delete=_FakeResponse(200),
    )
    out = client.reset('http://localhost:8000', 'ck_test', dataset='main', timeout=5)
    assert out == {'dataset': 'main', 'status': 'reset', 'deleted': True}
    assert [c['method'] for c in calls] == ['GET', 'DELETE']
    assert calls[1]['url'] == 'http://localhost:8000/api/v1/datasets/u2'


def test_reset_client_delete_404_is_not_found(monkeypatch):
    """DELETE 404 (already gone) is reported as not_found, never raised — the regression guard."""
    _stub_request(
        monkeypatch,
        get=_FakeResponse(200, {'datasets': [{'id': 'u2', 'name': 'main'}]}),
        delete=_FakeResponse(404),
    )
    out = client.reset('http://localhost:8000', 'ck_test', dataset='main', timeout=5)
    assert out == {'dataset': 'main', 'status': 'not_found', 'deleted': False}


def _stub_request_with_retry(monkeypatch, *, get=None, get_exc=None, delete_exc=None):
    """Stub ``cognee_client._request_with_retry`` directly, bypassing tenacity's retry/backoff.

    For the two "final failure after retries exhausted" cases below: whether ``tenacity`` is
    the in-file passthrough stub (isolated unit runs) or the real dependency (``./builder
    nodes:test``, which really retries 429/5xx/timeout with real backoff) is an environment
    detail ``reset()`` shouldn't care about. Raising directly here models the exception tenacity
    re-raises once attempts are exhausted, without depending on real sleep timing or attempt
    counts.
    """
    calls = []

    def fake(method, url, *, headers, timeout):
        calls.append(method)
        if method == 'GET':
            if get_exc is not None:
                raise get_exc
            return get
        if method == 'DELETE':
            if delete_exc is not None:
                raise delete_exc
            raise AssertionError('unexpected DELETE call')
        raise AssertionError(f'unexpected method {method}')

    monkeypatch.setattr(client, '_request_with_retry', fake)
    return calls


def test_reset_client_delete_500_raises_without_key_leak(monkeypatch):
    """A non-404 DELETE error (e.g. exhausted 500 retries) raises RuntimeError, no key leak."""
    err = requests.exceptions.HTTPError('500 error')
    err.response = _FakeResponse(500)
    calls = _stub_request_with_retry(
        monkeypatch,
        get=_FakeResponse(200, {'datasets': [{'id': 'u2', 'name': 'main'}]}),
        delete_exc=err,
    )
    with pytest.raises(RuntimeError) as ei:
        client.reset('http://localhost:8000', 'ck_supersecret', dataset='main', timeout=5)
    assert 'ck_supersecret' not in str(ei.value)
    assert 'reset request failed' in str(ei.value)
    assert calls == ['GET', 'DELETE']


def test_reset_client_get_transport_error_raises_without_key_leak(monkeypatch):
    """A transport failure exhausting retries on the GET raises RuntimeError; no key leak, no DELETE."""
    calls = _stub_request_with_retry(monkeypatch, get_exc=requests.exceptions.ConnectionError('connect failed'))
    with pytest.raises(RuntimeError) as ei:
        client.reset('http://localhost:8000', 'ck_supersecret', dataset='main', timeout=5)
    assert 'ck_supersecret' not in str(ei.value)
    assert calls == ['GET']


def _http_error(status):
    """Build an HTTPError with a fake response of the given status (or no response when None)."""
    err = requests.exceptions.HTTPError(f'{status} error')
    err.response = _FakeResponse(status) if status is not None else None
    return err


# ---------------------------------------------------------------------------
# Modern memory client
# ---------------------------------------------------------------------------


def test_remember_posts_one_multipart_file_to_api_v1_remember(monkeypatch):
    """Remember uploads exactly one UTF-8 markdown file with JSON-compatible form fields."""
    calls = []

    def fake_post(url, **kwargs):
        calls.append({'url': url, **kwargs})
        return _FakeResponse(
            payload={
                'status': 'DATASET_PROCESSING_STARTED',
                'dataset_name': 'demo',
                'dataset_id': 'dataset-uuid',
                'pipeline_run_id': 'run-uuid',
            }
        )

    monkeypatch.setattr(client.requests, 'post', fake_post)

    result = client.remember(
        'https://cognee.example',
        'sentinel-secret',
        text='Ada wrote the first algorithm. ✓',
        dataset='demo',
        run_in_background=True,
        timeout=19,
    )

    assert result['pipeline_run_id'] == 'run-uuid'
    assert calls == [
        {
            'url': 'https://cognee.example/api/v1/remember',
            'headers': {'accept': 'application/json', 'X-Api-Key': 'sentinel-secret'},
            'files': [
                (
                    'data',
                    ('memory.md', 'Ada wrote the first algorithm. ✓'.encode(), 'text/markdown'),
                )
            ],
            'data': {'datasetName': 'demo', 'run_in_background': 'true'},
            'timeout': 19,
        }
    ]


def test_remember_is_single_attempt_on_timeout(monkeypatch):
    """A non-idempotent remember timeout is surfaced after one POST without leaking secrets."""
    calls = []

    def timeout(*args, **kwargs):
        calls.append((args, kwargs))
        raise requests.exceptions.Timeout('sentinel-secret timed out')

    monkeypatch.setattr(client.requests, 'post', timeout)

    with pytest.raises(client.CogneeRequestError) as error:
        client.remember(
            'https://cognee.example',
            'sentinel-secret',
            text='memory',
            dataset='demo',
            run_in_background=False,
            timeout=7,
        )

    assert len(calls) == 1
    assert 'sentinel-secret' not in str(error.value)


def test_recall_posts_include_references_and_is_single_attempt(monkeypatch):
    """Recall uses the modern JSON contract and does not retry its completion-generating POST."""
    calls = []

    def fake_post(url, **kwargs):
        calls.append({'url': url, **kwargs})
        return _FakeResponse(payload=[{'text': 'Ada', 'references': [{'id': 'source-1'}]}])

    monkeypatch.setattr(client.requests, 'post', fake_post)

    result = client.recall(
        'https://cognee.example',
        'sentinel-secret',
        query='Who wrote the first algorithm?',
        dataset='demo',
        search_type='GRAPH_COMPLETION_DECOMPOSITION',
        top_k=8,
        include_references=True,
        timeout=23,
    )

    assert result == [{'text': 'Ada', 'references': [{'id': 'source-1'}]}]
    assert calls == [
        {
            'url': 'https://cognee.example/api/v1/recall',
            'headers': {'accept': 'application/json', 'X-Api-Key': 'sentinel-secret'},
            'json': {
                'query': 'Who wrote the first algorithm?',
                'datasets': ['demo'],
                'searchType': 'GRAPH_COMPLETION_DECOMPOSITION',
                'topK': 8,
                'include_references': True,
            },
            'timeout': 23,
        }
    ]


def test_list_datasets_gets_api_v1_datasets_collection(monkeypatch):
    """Dataset discovery calls the trailing-slash collection URL and returns its list."""
    calls = []
    rows = [
        {
            'id': 'dataset-uuid',
            'name': 'demo',
            'createdAt': '2026-07-14T00:00:00Z',
            'updatedAt': '2026-07-14T00:00:00Z',
            'ownerId': 'owner-uuid',
        }
    ]

    def fake_request(method, url, *, headers, timeout, **kwargs):
        calls.append({'method': method, 'url': url, 'headers': headers, 'timeout': timeout, **kwargs})
        return _FakeResponse(payload=rows)

    monkeypatch.setattr(client.requests, 'request', fake_request, raising=False)

    assert client.list_datasets('https://cognee.example', 'sentinel-secret', timeout=11) == rows
    assert calls == [
        {
            'method': 'GET',
            'url': 'https://cognee.example/api/v1/datasets/',
            'headers': {'accept': 'application/json', 'X-Api-Key': 'sentinel-secret'},
            'timeout': 11,
        }
    ]


def test_status_sends_dataset_uuid_and_cognify_pipeline(monkeypatch):
    """Pipeline status addresses the dataset by UUID and explicitly selects cognify."""
    calls = []

    def fake_request(method, url, *, headers, timeout, **kwargs):
        calls.append({'method': method, 'url': url, 'headers': headers, 'timeout': timeout, **kwargs})
        return _FakeResponse(payload={'dataset-uuid': 'DATASET_PROCESSING_STARTED'})

    monkeypatch.setattr(client.requests, 'request', fake_request, raising=False)

    status = client.get_dataset_status(
        'https://cognee.example', 'sentinel-secret', dataset_id='dataset-uuid', timeout=13
    )

    assert status == 'running'
    assert calls == [
        {
            'method': 'GET',
            'url': 'https://cognee.example/api/v1/datasets/status',
            'headers': {'accept': 'application/json', 'X-Api-Key': 'sentinel-secret'},
            'timeout': 13,
            'params': {'dataset': 'dataset-uuid', 'pipeline': 'cognify_pipeline'},
        }
    ]


@pytest.mark.parametrize(
    ('remote_status', 'normalized'),
    [
        ('DATASET_PROCESSING_INITIATED', 'pending'),
        ('DATASET_PROCESSING_STARTED', 'running'),
        ('DATASET_PROCESSING_COMPLETED', 'completed'),
        ('DATASET_PROCESSING_ERRORED', 'failed'),
    ],
)
def test_status_normalizes_initiated_started_completed_errored(monkeypatch, remote_status, normalized):
    """Cognee pipeline enum values become a stable four-state status vocabulary."""

    def fake_request(*_args, **_kwargs):
        return _FakeResponse(payload={'dataset-uuid': remote_status})

    monkeypatch.setattr(client.requests, 'request', fake_request, raising=False)

    assert (
        client.get_dataset_status('https://cognee.example', 'sentinel-secret', dataset_id='dataset-uuid', timeout=5)
        == normalized
    )


def test_visualization_requires_nonempty_html(monkeypatch):
    """Visualization returns nonempty HTML bytes plus media type and rejects an empty body."""
    responses = [
        _FakeResponse(content=b'<html>graph</html>', headers={'Content-Type': 'text/html; charset=utf-8'}),
        _FakeResponse(content=b'', headers={'Content-Type': 'text/html'}),
    ]
    calls = []

    def fake_request(method, url, *, headers, timeout, **kwargs):
        calls.append({'method': method, 'url': url, 'headers': headers, 'timeout': timeout, **kwargs})
        return responses.pop(0)

    monkeypatch.setattr(client.requests, 'request', fake_request, raising=False)

    html, media_type = client.get_visualization_html(
        'https://cognee.example', 'sentinel-secret', dataset_id='dataset-uuid', timeout=17
    )
    assert html == b'<html>graph</html>'
    assert media_type == 'text/html; charset=utf-8'

    with pytest.raises(client.CogneeRequestError, match='empty HTML'):
        client.get_visualization_html(
            'https://cognee.example', 'sentinel-secret', dataset_id='dataset-uuid', timeout=17
        )

    assert calls[0] == {
        'method': 'GET',
        'url': 'https://cognee.example/api/v1/visualize',
        'headers': {'accept': 'application/json', 'X-Api-Key': 'sentinel-secret'},
        'timeout': 17,
        'params': {'dataset_id': 'dataset-uuid'},
    }


def test_http_errors_are_redacted_and_402_is_distinct(monkeypatch):
    """Client errors never echo vendor details or keys, and 402 explains exhausted budget."""
    responses = [_FakeResponse(status_code=400), _FakeResponse(status_code=402)]

    def fake_request(*_args, **_kwargs):
        response = responses.pop(0)
        response._payload = {'error': 'sentinel-secret vendor detail'}
        return response

    monkeypatch.setattr(client.requests, 'request', fake_request, raising=False)

    with pytest.raises(client.CogneeRequestError) as server_error:
        client.list_datasets('https://cognee.example', 'sentinel-secret', timeout=5)
    with pytest.raises(client.CogneeRequestError) as budget_error:
        client.list_datasets('https://cognee.example', 'sentinel-secret', timeout=5)

    assert 'sentinel-secret' not in str(server_error.value)
    assert 'token budget exhausted' not in str(server_error.value).lower()
    assert 'sentinel-secret' not in str(budget_error.value)
    assert 'token budget exhausted' in str(budget_error.value).lower()


def test_artifact_writer_contains_sanitizes_and_atomically_replaces(tmp_path, monkeypatch):
    """Artifact paths stay contained, names are safe, and replacement uses a sibling temp file."""
    artifact_store = importlib.import_module('tool_cognee.artifact_store')
    expected = (tmp_path / 'Team-Alpha-graph.html').resolve()
    expected.write_bytes(b'old graph')
    real_replace = artifact_store.os.replace
    replacements = []

    def recording_replace(source, destination):
        replacements.append((Path(source).resolve(), Path(destination).resolve()))
        real_replace(source, destination)

    monkeypatch.setattr(artifact_store.os, 'replace', recording_replace)

    written = artifact_store.write_html_artifact(
        tmp_path,
        dataset='../../Team / Alpha?*',
        html=b'<html>new graph</html>',
    )

    assert written == expected
    assert written.parent == tmp_path.resolve()
    assert written.read_bytes() == b'<html>new graph</html>'
    assert (written.stat().st_mode & 0o777) == 0o600
    assert len(replacements) == 1
    source, destination = replacements[0]
    assert source.parent == destination.parent == tmp_path.resolve()
    assert source != destination == written
    assert not source.exists()


@pytest.mark.parametrize(
    ('exc', 'expected'),
    [
        (_http_error(429), True),  # rate limited
        (_http_error(500), True),  # server error
        (_http_error(503), True),  # server error (upper 5xx)
        (_http_error(404), False),  # 4xx other than 429 is terminal
        (_http_error(None), False),  # HTTPError with no response attached
        (requests.exceptions.Timeout('t'), True),
        (requests.exceptions.ConnectionError('c'), True),
        (ValueError('not an http/transport error'), False),
    ],
)
def test_is_retryable_classification(exc, expected):
    """_is_retryable retries only transient 429/5xx/timeout/connection failures.

    Exercised directly (not through tenacity's loop), so the classification is
    verified regardless of whether the stub or the real tenacity backend is loaded.
    """
    assert client._is_retryable(exc) is expected


# ---------------------------------------------------------------------------
# add
# ---------------------------------------------------------------------------


def test_add_delegates_with_defaults(captured):
    """Add validates text and delegates with the configured dataset + timeout."""
    inst = _instance(_make_global())
    out = inst.add({'text': 'Ada wrote the first algorithm.'})
    assert out == {'status': 'ok'}
    call = captured['calls'][-1]
    assert call['name'] == 'add'
    assert call['base_url'] == 'http://localhost:8000' and call['api_key'] == 'ck_test'
    assert call['kwargs']['text'] == 'Ada wrote the first algorithm.'
    assert call['kwargs']['dataset'] == 'main'
    assert call['kwargs']['run_in_background'] is False
    assert call['kwargs']['timeout'] == 120


def test_add_dataset_and_background_override(captured):
    """Per-call dataset and run_in_background override the config."""
    inst = _instance(_make_global())
    inst.add({'text': 'x', 'dataset': 'docs', 'run_in_background': True})
    kw = captured['calls'][-1]['kwargs']
    assert kw['dataset'] == 'docs' and kw['run_in_background'] is True


def test_add_requires_text(captured):
    """Add raises ValueError (no client call) when text is missing/blank."""
    inst = _instance(_make_global())
    with pytest.raises(ValueError):
        inst.add({'text': '   '})
    with pytest.raises(ValueError):
        inst.add({})
    assert captured['calls'] == []


# ---------------------------------------------------------------------------
# cognify
# ---------------------------------------------------------------------------


def test_cognify_delegates_default_dataset(captured):
    """Cognify delegates with the configured dataset and synchronous default."""
    inst = _instance(_make_global())
    out = inst.cognify({})
    assert out == {'status': 'ok'}
    kw = captured['calls'][-1]['kwargs']
    assert kw['dataset'] == 'main' and kw['run_in_background'] is False


def test_cognify_dataset_override(captured):
    """Cognify honors a per-call dataset override."""
    inst = _instance(_make_global())
    inst.cognify({'dataset': 'docs', 'run_in_background': True})
    kw = captured['calls'][-1]['kwargs']
    assert kw['dataset'] == 'docs' and kw['run_in_background'] is True


# ---------------------------------------------------------------------------
# search
# ---------------------------------------------------------------------------


def test_search_delegates_and_shapes_count(captured):
    """Search builds the query and returns results + count from the client list."""
    captured['search'] = [{'text': 'answer one'}, {'text': 'answer two'}]
    inst = _instance(_make_global())
    out = inst.search({'query': 'who wrote it?'})
    assert out['count'] == 2 and out['results'][0]['text'] == 'answer one'
    kw = captured['calls'][-1]['kwargs']
    assert kw['query'] == 'who wrote it?'
    assert kw['search_type'] == 'GRAPH_COMPLETION'
    assert kw['dataset'] == 'main'
    assert kw['top_k'] == 15


def test_search_requires_query(captured):
    """Search raises ValueError (no client call) on an empty query."""
    inst = _instance(_make_global())
    with pytest.raises(ValueError):
        inst.search({'query': '  '})
    assert captured['calls'] == []


def test_search_invalid_type_falls_back_to_config(captured):
    """An unknown search_type falls back to the configured default."""
    captured['search'] = []
    inst = _instance(_make_global(search_type='RAG_COMPLETION'))
    inst.search({'query': 'q', 'search_type': 'NONSENSE'})
    assert captured['calls'][-1]['kwargs']['search_type'] == 'RAG_COMPLETION'


def test_search_valid_type_override_is_uppercased(captured):
    """A valid per-call search_type is accepted (case-insensitively)."""
    captured['search'] = []
    inst = _instance(_make_global())
    inst.search({'query': 'q', 'search_type': 'chunks'})
    assert captured['calls'][-1]['kwargs']['search_type'] == 'CHUNKS'


def test_search_top_k_guards_bool_and_clamps(captured):
    """top_k rejects booleans (JSON true) and clamps to 1..100."""
    captured['search'] = []
    inst = _instance(_make_global())
    inst.search({'query': 'q', 'top_k': True})  # bool must not become 1
    assert captured['calls'][-1]['kwargs']['top_k'] == 15
    inst.search({'query': 'q', 'top_k': 999})
    assert captured['calls'][-1]['kwargs']['top_k'] == 100
    inst.search({'query': 'q', 'top_k': 0})
    assert captured['calls'][-1]['kwargs']['top_k'] == 1


# ---------------------------------------------------------------------------
# reset
# ---------------------------------------------------------------------------


def test_reset_delegates_default_dataset(captured):
    """Reset delegates with the configured dataset."""
    captured['reset'] = {'dataset': 'main', 'status': 'reset', 'deleted': True}
    inst = _instance(_make_global())
    out = inst.reset({})
    assert out['deleted'] is True
    assert captured['calls'][-1]['kwargs']['dataset'] == 'main'


def test_reset_dataset_override(captured):
    """Reset honors a per-call dataset override."""
    captured['reset'] = {'dataset': 'docs', 'status': 'not_found', 'deleted': False}
    inst = _instance(_make_global())
    inst.reset({'dataset': 'docs'})
    assert captured['calls'][-1]['kwargs']['dataset'] == 'docs'


# ---------------------------------------------------------------------------
# error propagation
# ---------------------------------------------------------------------------


def test_tool_propagates_client_runtimeerror(monkeypatch):
    """A client RuntimeError propagates out of the tool (never swallowed into a dict)."""

    def boom(*a, **k):
        raise RuntimeError('cognee: search request failed (HTTP 500): HTTPError')

    monkeypatch.setattr(client, 'search', boom)
    inst = _instance(_make_global())
    with pytest.raises(RuntimeError):
        inst.search({'query': 'q'})
