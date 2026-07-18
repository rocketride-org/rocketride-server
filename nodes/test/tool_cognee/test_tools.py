# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Unit tests for the tool_cognee node.

Pure-Python: no server, no engine, no real HTTP. The node module is imported
under composable stubs for ``rocketlib`` and ``ai.common.*`` so the relative
imports resolve without the engine runtime. Tool methods are tested by patching
the ``cognee_client`` helper functions; the client's own HTTP layer is exercised
for the supported REST contracts and key redaction (with ``requests`` patched to
raise).

Covers the supported REST contracts — ``remember``, ``recall``, and dataset
status — and the exact public tool surface — ``remember``, ``recall``, and
``memory_status`` — plus lifecycle/config validation and delegation without
live Cognee calls.
"""

from __future__ import annotations

import ast
import importlib
import inspect
import json
import textwrap
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

IGlobalMod = importlib.import_module('tool_cognee.IGlobal')


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
    glb.allow_dataset_override = False
    glb.search_type = 'GRAPH_COMPLETION_DECOMPOSITION'
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


# ---------------------------------------------------------------------------
# cognee_client pure helpers
# ---------------------------------------------------------------------------


def test_headers_include_key_only_when_set():
    """X-Api-Key is sent only when a key is configured; accept is always present."""
    assert client._headers('ck_x') == {'accept': 'application/json', 'X-Api-Key': 'ck_x'}
    assert client._headers('') == {'accept': 'application/json'}


class _FakeResponse:
    """Minimal ``requests.Response`` stand-in: status_code, json(), raise_for_status()."""

    def __init__(
        self,
        status_code=200,
        payload=None,
        *,
        content=b'{}',
        headers=None,
        json_error=None,
    ):
        self.status_code = status_code
        self._payload = {} if payload is None else payload
        self.content = content
        self.headers = {} if headers is None else headers
        self._json_error = json_error

    def json(self):
        """Return the canned JSON payload."""
        if self._json_error is not None:
            raise self._json_error
        return self._payload

    def raise_for_status(self):
        """Raise HTTPError with ``.response`` set, mirroring real requests behavior."""
        if self.status_code >= 400:
            err = requests.exceptions.HTTPError(f'{self.status_code} error')
            err.response = self
            raise err


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


def test_recall_always_requests_references_when_caller_passes_false(monkeypatch):
    """The wire contract keeps references enabled even when a caller attempts to disable them."""
    calls = []

    def fake_post(url, **kwargs):
        calls.append({'url': url, **kwargs})
        return _FakeResponse(payload=[{'text': 'Ada', 'references': []}])

    monkeypatch.setattr(client.requests, 'post', fake_post)

    client.recall(
        'https://cognee.example',
        'sentinel-secret',
        query='Who wrote the first algorithm?',
        dataset='demo',
        search_type='GRAPH_COMPLETION_DECOMPOSITION',
        top_k=8,
        include_references=False,
        timeout=23,
    )

    assert calls[0]['json']['include_references'] is True


@pytest.mark.parametrize(
    ('content', 'payload', 'json_error'),
    [
        (b'', None, None),
        (b'sentinel-secret invalid JSON', None, ValueError('sentinel-secret invalid JSON')),
        (b'{"unexpected":"sentinel-secret"}', {'unexpected': 'sentinel-secret'}, None),
    ],
    ids=['empty-body', 'invalid-json', 'wrong-shape'],
)
def test_remember_rejects_invalid_successful_response(
    monkeypatch,
    content,
    payload,
    json_error,
):
    """A 2xx remember response must contain valid JSON in the expected run-result shape."""

    def fake_post(*_args, **_kwargs):
        return _FakeResponse(content=content, payload=payload, json_error=json_error)

    monkeypatch.setattr(client.requests, 'post', fake_post)

    with pytest.raises(client.CogneeRequestError) as error:
        client.remember(
            'https://cognee.example',
            'sentinel-secret',
            text='memory',
            dataset='demo',
            run_in_background=False,
            timeout=7,
        )

    assert str(error.value) == 'cognee: remember returned an invalid response'
    assert 'sentinel-secret' not in str(error.value)


@pytest.mark.parametrize(
    ('content', 'payload', 'json_error'),
    [
        (b'', None, None),
        (b'sentinel-secret invalid JSON', None, ValueError('sentinel-secret invalid JSON')),
        (b'{"unexpected":"sentinel-secret"}', {'unexpected': 'sentinel-secret'}, None),
    ],
    ids=['empty-body', 'invalid-json', 'wrong-shape'],
)
def test_recall_rejects_invalid_successful_response(
    monkeypatch,
    content,
    payload,
    json_error,
):
    """A 2xx recall response must contain valid JSON as a list of result objects."""

    def fake_post(*_args, **_kwargs):
        return _FakeResponse(content=content, payload=payload, json_error=json_error)

    monkeypatch.setattr(client.requests, 'post', fake_post)

    with pytest.raises(client.CogneeRequestError) as error:
        client.recall(
            'https://cognee.example',
            'sentinel-secret',
            query='Who wrote the first algorithm?',
            dataset='demo',
            search_type='GRAPH_COMPLETION_DECOMPOSITION',
            top_k=8,
            include_references=True,
            timeout=23,
        )

    assert str(error.value) == 'cognee: recall returned an invalid response'
    assert 'sentinel-secret' not in str(error.value)


def test_recall_timeout_is_one_attempt_and_redacted(monkeypatch):
    """A recall timeout is never retried and never exposes transport text or the API key."""
    calls = []

    def timeout(*args, **kwargs):
        calls.append((args, kwargs))
        raise requests.exceptions.Timeout('sentinel-secret timed out')

    monkeypatch.setattr(client.requests, 'post', timeout)

    with pytest.raises(client.CogneeRequestError) as error:
        client.recall(
            'https://cognee.example',
            'sentinel-secret',
            query='Who wrote the first algorithm?',
            dataset='demo',
            search_type='GRAPH_COMPLETION_DECOMPOSITION',
            top_k=8,
            include_references=True,
            timeout=23,
        )

    assert len(calls) == 1
    assert 'sentinel-secret' not in str(error.value)


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
    """Memory status addresses the dataset by UUID and selects its Cognee pipeline."""
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
# Public tool surface
# ---------------------------------------------------------------------------


_PUBLIC_TOOLS = {'remember', 'recall', 'memory_status'}


def _decorated_tools():
    """Return the public methods decorated as RocketRide tools."""
    return {
        name: member
        for name, member in vars(IInstance).items()
        if callable(member) and hasattr(member, '__tool_meta__')
    }


def test_tool_catalog_exposes_only_shared_memory_essentials():
    """The LLM sees exactly the three shared-memory operations."""
    assert set(_decorated_tools()) == _PUBLIC_TOOLS
    for removed in (
        'reset',
        'delete_dataset',
        'export_visualization',
        'add',
        'cognify',
        'search',
        'pipeline_status',
    ):
        assert removed not in _decorated_tools()


def test_legacy_public_tools_and_descriptions_are_absent():
    """No legacy, destructive, or generic repository-ingestion surface remains public."""
    for legacy in ('add', 'cognify', 'search', 'reset', 'delete_dataset', 'export_visualization', 'pipeline_status'):
        assert not hasattr(IInstance, legacy)

    remember_properties = IInstance.remember.__tool_meta__['input_schema']['properties']
    assert set(remember_properties) == {'text', 'dataset', 'run_in_background'}
    assert 'url' not in remember_properties['text']['description'].lower()
    assert 'repo' not in remember_properties['text']['description'].lower()


def test_inventory_methods_normalize_first_with_their_exact_tool_name():
    """Each tool's first executable statement normalizes using its public name."""
    for name, method in _decorated_tools().items():
        tree = compile(textwrap.dedent(inspect.getsource(method)), '<tool>', 'exec', ast.PyCF_ONLY_AST)
        function = tree.body[0]
        first = function.body[0]
        assert isinstance(first, ast.Assign)
        call = first.value
        assert isinstance(call, ast.Call)
        assert getattr(call.func, 'id', None) == 'normalize_tool_input'
        tool_name = next(keyword.value for keyword in call.keywords if keyword.arg == 'tool_name')
        assert tool_name.value == name


@pytest.fixture
def modern_calls(monkeypatch):
    """Capture modern client delegation without making HTTP calls."""
    state = {'calls': [], 'remember': {'status': 'started'}, 'recall': []}

    def record(name):
        def fake(base_url, api_key, **kwargs):
            state['calls'].append({'name': name, 'base_url': base_url, 'api_key': api_key, 'kwargs': kwargs})
            return state[name]

        return fake

    monkeypatch.setattr(client, 'remember', record('remember'))
    monkeypatch.setattr(client, 'recall', record('recall'))
    return state


def test_remember_delegates_plain_text_only(modern_calls):
    """Remember accepts plain text and delegates to the one-step memory endpoint."""
    inst = _instance(_make_global())
    result = inst.remember({'text': 'Ada wrote the first algorithm.', 'run_in_background': True})
    assert result == {'status': 'started'}
    assert modern_calls['calls'] == [
        {
            'name': 'remember',
            'base_url': 'http://localhost:8000',
            'api_key': 'ck_test',
            'kwargs': {
                'text': 'Ada wrote the first algorithm.',
                'dataset': 'main',
                'run_in_background': True,
                'timeout': 120,
            },
        }
    ]


def test_recall_defaults_to_decomposition_with_references(modern_calls):
    """Recall uses graph decomposition by default and always asks for provenance."""
    modern_calls['recall'] = [{'text': 'Ada', 'references': [{'id': 'source-1'}]}]
    inst = _instance(_make_global())
    result = inst.recall({'query': 'Who wrote the first algorithm?'})
    assert result == {'results': modern_calls['recall'], 'count': 1}
    assert modern_calls['calls'][-1]['kwargs'] == {
        'query': 'Who wrote the first algorithm?',
        'dataset': 'main',
        'search_type': 'GRAPH_COMPLETION_DECOMPOSITION',
        'top_k': 15,
        'include_references': True,
        'timeout': 120,
    }


@pytest.mark.parametrize(
    ('tool_name', 'args', 'client_name', 'kwargs'),
    [
        ('remember', {'text': 'memory'}, 'remember', {'text': 'memory', 'run_in_background': False}),
        ('recall', {'query': 'question'}, 'recall', {'query': 'question'}),
    ],
)
def test_tools_use_configured_dataset_when_omitted(modern_calls, tool_name, args, client_name, kwargs):
    """Remember and recall bind omitted datasets to the node-configured scope."""
    glb = _make_global(dataset='team-memory')
    getattr(_instance(glb), tool_name)(args)
    call = next(call for call in modern_calls['calls'] if call['name'] == client_name)
    assert call['kwargs']['dataset'] == 'team-memory'
    assert call['kwargs'].items() >= kwargs.items()


@pytest.mark.parametrize(
    ('tool_name', 'args'),
    [
        ('remember', {'text': 'memory', 'dataset': 'project-b'}),
        ('recall', {'query': 'question', 'dataset': 'project-b'}),
    ],
)
def test_different_dataset_override_is_rejected_by_default(tool_name, args):
    """Remember and recall reject a dataset that differs from the operator scope."""
    with pytest.raises(ValueError, match='dataset'):
        getattr(_instance(_make_global(dataset='team-memory')), tool_name)(args)


@pytest.mark.parametrize(
    ('tool_name', 'args'),
    [
        ('remember', {'text': 'memory', 'dataset': ' team-memory '}),
        ('recall', {'query': 'question', 'dataset': ' team-memory '}),
    ],
)
def test_equal_dataset_override_is_accepted_by_default(modern_calls, tool_name, args):
    """An explicit spelling of the configured dataset remains valid by default."""
    getattr(_instance(_make_global(dataset='team-memory')), tool_name)(args)
    assert modern_calls['calls'][-1]['kwargs']['dataset'] == 'team-memory'


@pytest.mark.parametrize(
    ('tool_name', 'args'),
    [
        ('remember', {'text': 'memory', 'dataset': ' project-b '}),
        ('recall', {'query': 'question', 'dataset': ' project-b '}),
    ],
)
def test_enabled_dataset_override_passes_trimmed_alternate_dataset(modern_calls, tool_name, args):
    """The explicit operator switch permits an alternate per-call dataset."""
    getattr(_instance(_make_global(dataset='team-memory', allow_dataset_override=True)), tool_name)(args)
    assert modern_calls['calls'][-1]['kwargs']['dataset'] == 'project-b'


@pytest.mark.parametrize(
    ('tool_name', 'args'),
    [
        ('remember', {'text': 'memory', 'dataset': '  '}),
        ('recall', {'query': 'question', 'dataset': '  '}),
        ('memory_status', {'dataset': '  '}),
        ('remember', {'text': 'memory', 'dataset': 1}),
        ('recall', {'query': 'question', 'dataset': 1}),
        ('memory_status', {'dataset': 1}),
    ],
)
def test_blank_dataset_is_rejected(tool_name, args):
    """An explicitly blank dataset is invalid rather than silently changing scope."""
    with pytest.raises(ValueError, match='dataset'):
        getattr(_instance(_make_global()), tool_name)(args)


@pytest.mark.parametrize(
    ('tool_name', 'args', 'field'),
    [
        ('remember', {'text': '  '}, 'text'),
        ('recall', {'query': '  '}, 'query'),
    ],
)
def test_blank_text_or_query_is_rejected(tool_name, args, field):
    """Remember and recall reject missing semantic input before delegation."""
    with pytest.raises(ValueError, match=field):
        getattr(_instance(_make_global()), tool_name)(args)


def test_recall_rejects_json_boolean_top_k():
    """JSON true is not accepted as integer one for recall result limits."""
    with pytest.raises(ValueError, match='top_k'):
        _instance(_make_global()).recall({'query': 'question', 'top_k': True})


def test_memory_status_resolves_dataset_name_to_uuid(monkeypatch):
    """Status lists datasets, resolves the exact name, then addresses the UUID."""
    calls = []

    def list_datasets(base_url, api_key, *, timeout):
        calls.append(('list', base_url, api_key, timeout))
        return [{'id': 'dataset-uuid', 'name': 'main'}]

    def get_status(base_url, api_key, *, dataset_id, timeout):
        calls.append(('status', base_url, api_key, dataset_id, timeout))
        return 'running'

    monkeypatch.setattr(client, 'list_datasets', list_datasets)
    monkeypatch.setattr(client, 'get_dataset_status', get_status)

    result = _instance(_make_global()).memory_status({})
    assert result == {'dataset': 'main', 'dataset_id': 'dataset-uuid', 'status': 'running'}
    assert calls == [
        ('list', 'http://localhost:8000', 'ck_test', 120),
        ('status', 'http://localhost:8000', 'ck_test', 'dataset-uuid', 120),
    ]


def test_memory_status_obeys_dataset_override_policy(monkeypatch):
    """Status rejects alternate scopes by default and uses them when the switch is enabled."""
    calls = []
    monkeypatch.setattr(
        client, 'list_datasets', lambda *_args, **_kwargs: [{'id': 'project-b-id', 'name': 'project-b'}]
    )
    monkeypatch.setattr(
        client,
        'get_dataset_status',
        lambda *_args, dataset_id, **_kwargs: calls.append(dataset_id) or 'completed',
    )

    with pytest.raises(ValueError, match='dataset'):
        _instance(_make_global(dataset='team-memory')).memory_status({'dataset': 'project-b'})

    result = _instance(_make_global(dataset='team-memory', allow_dataset_override=True)).memory_status(
        {'dataset': ' project-b '}
    )
    assert result == {'dataset': 'project-b', 'dataset_id': 'project-b-id', 'status': 'completed'}
    assert calls == ['project-b-id']


def test_memory_status_rejects_unknown_dataset(monkeypatch):
    """A missing dataset is a clear input error and never triggers a status request."""
    monkeypatch.setattr(client, 'list_datasets', lambda *_args, **_kwargs: [])
    with pytest.raises(ValueError, match='not found'):
        _instance(_make_global(dataset='missing')).memory_status({})


def test_tool_propagates_client_runtimeerror(monkeypatch):
    """A client RuntimeError propagates out of the tool and is never returned as a dict."""

    def boom(*_args, **_kwargs):
        raise RuntimeError('cognee: recall request failed (HTTP 500)')

    monkeypatch.setattr(client, 'recall', boom)
    with pytest.raises(RuntimeError):
        _instance(_make_global()).recall({'query': 'question'})


# ---------------------------------------------------------------------------
# Global lifecycle and service schema
# ---------------------------------------------------------------------------


def _configured_global(open_mode='run'):
    """Create an IGlobal with the minimal engine attributes used by lifecycle methods."""
    glb = IGlobal()
    glb.IEndpoint = types.SimpleNamespace(endpoint=types.SimpleNamespace(openMode=open_mode))
    glb.glb = types.SimpleNamespace(logicalType='tool_cognee', connConfig={})
    return glb


def test_global_config_mode_skips_setup(monkeypatch):
    """Canvas configuration mode does not load config or initialize runtime state."""
    monkeypatch.setattr(
        IGlobalMod.Config,
        'getNodeConfig',
        lambda *_args, **_kwargs: pytest.fail('CONFIG mode must skip setup'),
    )
    _configured_global(open_mode=IGlobalMod.OPEN_MODE.CONFIG).beginGlobal()


def test_global_loads_exact_runtime_configuration(monkeypatch):
    """Runtime setup loads the shared-memory configuration values."""
    config = {
        'base_url': 'https://cognee.example/',
        'api_key': '',
        'dataset': 'demo',
        'allow_dataset_override': True,
        'search_type': 'GRAPH_COMPLETION_DECOMPOSITION',
        'top_k': 7,
        'request_timeout': 45,
    }
    monkeypatch.setenv('COGNEE_API_KEY', 'env-key')
    monkeypatch.setattr(IGlobalMod.Config, 'getNodeConfig', lambda *_args: config)

    glb = _configured_global()
    glb.beginGlobal()

    assert glb.base_url == 'https://cognee.example'
    assert glb.api_key == 'env-key'
    assert glb.dataset == 'demo'
    assert glb.allow_dataset_override is True
    assert glb.search_type == 'GRAPH_COMPLETION_DECOMPOSITION'
    assert glb.top_k == 7
    assert glb.request_timeout == 45


def test_global_validate_config_warns_instead_of_raising(monkeypatch):
    """Invalid editor-time configuration emits warnings and stays nonfatal."""
    warnings = []
    monkeypatch.setattr(
        IGlobalMod.Config,
        'getNodeConfig',
        lambda *_args: {'base_url': ''},
    )
    monkeypatch.setattr(IGlobalMod, 'warning', warnings.append)
    _configured_global().validateConfig()
    assert any('base_url' in message for message in warnings)


def test_global_end_clears_api_key():
    """Pipe teardown removes the credential from process memory."""
    glb = _configured_global()
    glb.api_key = 'sentinel-secret'
    glb.endGlobal()
    assert glb.api_key == ''


def _load_services():
    """Parse services.json after dropping its full-line JSONC comments."""
    text = '\n'.join(
        line for line in (_NODE_DIR / 'services.json').read_text().splitlines() if not line.lstrip().startswith('//')
    )
    return json.loads(text)


@pytest.mark.parametrize('value', ['true', 1, None])
def test_global_defaults_non_boolean_dataset_override_to_false(monkeypatch, value):
    """Only a JSON boolean can enable per-call dataset selection at runtime."""
    monkeypatch.setattr(
        IGlobalMod.Config,
        'getNodeConfig',
        lambda *_args: {'base_url': 'https://cognee.example', 'allow_dataset_override': value},
    )
    glb = _configured_global()
    glb.beginGlobal()
    assert glb.allow_dataset_override is False


def test_global_services_expose_dataset_override_boolean_in_profile_and_shape():
    """The schema makes the opt-in shared-memory scope escape hatch explicit."""
    services = _load_services()
    assert services['classType'] == ['tool']
    assert services['capabilities'] == ['invoke']
    assert services['lanes'] == {}
    assert set(services['fields']) == {
        'cognee.base_url',
        'cognee.api_key',
        'cognee.dataset',
        'cognee.allow_dataset_override',
        'cognee.search_type',
        'cognee.top_k',
        'cognee.request_timeout',
    }
    assert services['fields']['cognee.api_key']['secure'] is True
    assert services['fields']['cognee.api_key']['ui']['ui:widget'] == 'ApiKeyWidget'
    override = services['fields']['cognee.allow_dataset_override']
    assert override['type'] == 'boolean'
    assert override['default'] is False
    assert services['preconfig']['profiles']['default']['allow_dataset_override'] is False
    assert 'cognee.allow_dataset_override' in services['shape'][0]['properties']
