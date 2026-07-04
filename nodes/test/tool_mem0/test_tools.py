# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Unit tests for the tool_mem0 node.

Pure-Python: no server, no engine, no real HTTP. The node module is imported
under composable stubs for ``rocketlib`` and ``ai.common.*`` so the relative
``from .IGlobal import IGlobal`` resolves without the engine runtime, and the
``requests`` call is replaced by patching the module's ``_request_with_retry``
(routed by URL: add vs event-poll vs search). ``time.sleep`` is patched so the
event-poll loop runs instantly.

Covers:
* ``_coerce_messages`` — messages array, ``content`` fallback, role default.
* ``_event_id_of`` — top-level vs results-wrapped event id.
* ``_shape_add`` — terminal SUCCEEDED/FAILED, queued (PENDING / receipt), sync.
* ``_shape_results`` — row shaping incl. memory/text fallback and bare list.
* ``remember`` — POST body, scope, async wait/poll to a terminal event.
* ``recall`` — POST body (top-level ids + top_k), scope requirement, shaping.
"""

from __future__ import annotations

import sys
import types
from pathlib import Path

import pytest

_NODE_DIR = Path(__file__).resolve().parent.parent.parent / 'src' / 'nodes' / 'tool_mem0'


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
    if not hasattr(sys.modules['ai.common.utils'], 'normalize_tool_input'):
        sys.modules['ai.common.utils'].normalize_tool_input = _passthrough
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
    mod.exceptions = exc
    mod.request = lambda *a, **k: None
    sys.modules['requests'] = mod
    sys.modules['requests.exceptions'] = exc


def _ensure_tenacity() -> None:
    """Stub ``tenacity`` if unavailable — the retry layer is patched out in tests."""
    if 'tenacity' in sys.modules:
        return
    mod = types.ModuleType('tenacity')
    mod.Retrying = lambda **_kw: lambda fn, *a, **k: fn(*a, **k)
    mod.stop_after_attempt = lambda *a, **k: None
    mod.stop_after_delay = lambda *a, **k: None
    mod.wait_exponential = lambda *a, **k: None
    mod.retry_if_exception = lambda *a, **k: None
    sys.modules['tenacity'] = mod


def _ensure_pkg() -> None:
    """Register a tool_mem0 package pointing at the node source directory."""
    if 'tool_mem0' not in sys.modules:
        pkg = types.ModuleType('tool_mem0')
        pkg.__path__ = [str(_NODE_DIR)]
        sys.modules['tool_mem0'] = pkg


_ensure_rocketlib()
_ensure_ai_common()
_ensure_requests()
_ensure_tenacity()
_ensure_pkg()

from tool_mem0 import IInstance as IInstanceMod  # noqa: E402
from tool_mem0.IInstance import (  # noqa: E402
    IInstance,
    _coerce_messages,
    _event_id_of,
    _shape_add,
    _shape_results,
)
from tool_mem0.IGlobal import IGlobal  # noqa: E402


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _pin_normalizer(monkeypatch):
    """Pin the input normalizer to a passthrough per test (scoped + auto-restored).

    Keeps ``remember`` / ``recall`` deterministic regardless of whatever
    ``ai.common.utils`` resolved to, without leaking the patch across tests.
    """
    monkeypatch.setattr(IInstanceMod, 'normalize_tool_input', _passthrough)


def _make_global(**overrides):
    """Build an IGlobal preset with test credentials, scope, and wait settings."""
    glb = IGlobal()
    glb.api_key = 'm0_test'
    glb.base_url = 'https://api.mem0.ai'
    glb.user_id = 'alice'
    glb.agent_id = ''
    glb.run_id = ''
    glb.app_id = ''
    glb.infer = True
    glb.wait = True
    glb.ingest_timeout = 30
    glb.search_limit = 10
    for k, v in overrides.items():
        setattr(glb, k, v)
    return glb


@pytest.fixture
def captured(monkeypatch):
    """Patch the HTTP layer (routed by URL) and make event polling instant."""
    state = {'calls': [], 'add': {}, 'event': {}, 'search': []}

    def fake_request(method, url, headers, *, payload=None, params=None, **kw):
        """Record the request and return the canned response routed by URL."""
        state['calls'].append(
            {
                'method': method,
                'url': url,
                'headers': headers,
                'payload': payload,
                'idempotent': kw.get('idempotent', True),
            }
        )
        if '/v1/event/' in url:
            return state['event']
        if '/v1/memories/search/' in url:
            return state['search']
        return state['add']

    monkeypatch.setattr(IInstanceMod, '_request_with_retry', fake_request)
    monkeypatch.setattr(IInstanceMod.time, 'sleep', lambda *a, **k: None)
    return state


def _instance(glb):
    """Construct an IInstance bound to the given IGlobal."""
    inst = IInstance()
    inst.IGlobal = glb
    return inst


# ---------------------------------------------------------------------------
# Pure helpers
# ---------------------------------------------------------------------------


def test_coerce_messages_variants():
    """Messages array, content fallback, and role-default normalization."""
    assert _coerce_messages([{'role': 'user', 'content': 'hi'}], None, None) == [{'role': 'user', 'content': 'hi'}]
    assert _coerce_messages(None, 'I am vegetarian', None) == [{'role': 'user', 'content': 'I am vegetarian'}]
    assert _coerce_messages(None, 'noted', 'assistant') == [{'role': 'assistant', 'content': 'noted'}]
    assert _coerce_messages(None, '   ', None) == []
    assert _coerce_messages([{'role': 'user', 'content': ''}], None, None) == []


def test_event_id_of_variants():
    """Event id parsed from top-level or results-wrapped responses."""
    assert _event_id_of({'event_id': 'e2'}) == 'e2'
    assert _event_id_of({'results': [{'event_id': 'e1', 'status': 'PENDING'}]}) == 'e1'
    assert _event_id_of({'results': []}) == ''
    assert _event_id_of([]) == ''


def test_shape_add_variants():
    """Terminal SUCCEEDED/FAILED, queued, and synchronous add shapes."""
    # Terminal event payload from _await_event -> succeeded with created memories.
    done = _shape_add({'status': 'SUCCEEDED', 'results': [{'id': 'm1', 'memory': 'x'}]}, 'evt_1')
    assert done == {
        'success': True,
        'status': 'succeeded',
        'event_id': 'evt_1',
        'memories_created': [{'id': 'm1', 'memory': 'x'}],
    }
    # Terminal failure.
    failed = _shape_add({'status': 'FAILED'}, 'evt_1')
    assert failed['success'] is False and failed['status'] == 'failed'
    # Non-terminal event -> queued.
    pending = _shape_add({'status': 'PENDING', 'event_id': 'evt_2'})
    assert pending == {'success': True, 'status': 'queued', 'event_id': 'evt_2', 'memories_created': []}
    # Async receipt wrapped in results -> queued, event id lifted out.
    receipt = _shape_add({'results': [{'event_id': 'evt_3', 'status': 'PENDING', 'message': 'queued'}]})
    assert receipt['status'] == 'queued' and receipt['event_id'] == 'evt_3' and receipt['memories_created'] == []
    # Synchronous create (results are real memories) and bare list.
    assert _shape_add({'results': [{'id': 'm1', 'memory': 'x'}]})['status'] == 'succeeded'
    assert _shape_add([{'id': 'm1', 'memory': 'x'}])['memories_created'] == [{'id': 'm1', 'memory': 'x'}]


def test_shape_results_variants():
    """Row shaping incl. memory/text fallback and a bare list."""
    rows = _shape_results(
        [
            {'id': 'm1', 'memory': 'User is vegetarian', 'score': 0.91, 'categories': ['food']},
            {'id': 'm2', 'text': 'Tokyo trip', 'score': 0.6},
        ]
    )
    assert rows[0] == {
        'id': 'm1',
        'memory': 'User is vegetarian',
        'score': 0.91,
        'metadata': {},
        'categories': ['food'],
    }
    assert rows[1]['memory'] == 'Tokyo trip'  # `text` fallback
    assert _shape_results({'results': [{'id': 'm3', 'memory': 'x'}]})[0]['id'] == 'm3'
    assert _shape_results(None) == []


# ---------------------------------------------------------------------------
# remember
# ---------------------------------------------------------------------------


def test_remember_waits_for_event_then_returns_created(captured):
    """Remember polls the event to terminal and returns the created memories."""
    # add() returns a queued receipt; the node polls the event to a terminal state.
    captured['add'] = {'results': [{'event_id': 'evt_1', 'status': 'PENDING', 'message': 'queued'}]}
    captured['event'] = {'status': 'SUCCEEDED', 'results': [{'id': 'm1', 'memory': 'User is vegetarian'}]}
    inst = _instance(_make_global(agent_id='agt_1'))

    out = inst.remember({'content': 'I am vegetarian', 'metadata': {'source': 'onboarding'}})

    assert out['success'] is True
    assert out['status'] == 'succeeded'
    assert out['event_id'] == 'evt_1'
    assert out['memories_created'] == [{'id': 'm1', 'memory': 'User is vegetarian'}]

    add_call = captured['calls'][0]
    assert add_call['method'] == 'POST'
    assert add_call['url'].endswith('/v1/memories/')
    assert add_call['headers']['Authorization'] == 'Token m0_test'
    assert add_call['idempotent'] is False  # non-idempotent write
    p = add_call['payload']
    assert p['messages'] == [{'role': 'user', 'content': 'I am vegetarian'}]
    # Entity ids TOP-LEVEL in the body (never a `filters` dict).
    assert p['user_id'] == 'alice'
    assert p['agent_id'] == 'agt_1'
    assert 'filters' not in p
    assert p['output_format'] == 'v1.1'
    assert p['version'] == 'v2'
    assert p['infer'] is True
    assert p['metadata'] == {'source': 'onboarding'}

    # It polled the documented event endpoint with the add's event id.
    poll_call = captured['calls'][-1]
    assert poll_call['method'] == 'GET'
    assert poll_call['url'].endswith('/v1/event/evt_1/')


def test_remember_wait_off_returns_queued(captured):
    """With wait off, remember returns the queued receipt without polling."""
    captured['add'] = {'results': [{'event_id': 'evt_9', 'status': 'PENDING', 'message': 'queued'}]}
    inst = _instance(_make_global(wait=False))

    out = inst.remember({'content': 'hi'})

    assert out['success'] is True
    assert out['status'] == 'queued'
    assert out['event_id'] == 'evt_9'
    assert out['memories_created'] == []
    # No event poll when wait is off.
    assert [c['url'] for c in captured['calls'] if '/v1/event/' in c['url']] == []


def test_remember_requires_scope(captured):
    """Remember errors (no HTTP call) when no scope is set."""
    inst = _instance(_make_global(user_id=''))
    out = inst.remember({'content': 'hello'})
    assert out['success'] is False
    assert 'scope' in out['error']
    assert captured['calls'] == []


def test_remember_requires_content(captured):
    """Remember errors (no HTTP call) when no messages/content given."""
    inst = _instance(_make_global())
    out = inst.remember({})
    assert out['success'] is False
    assert captured['calls'] == []


# ---------------------------------------------------------------------------
# recall
# ---------------------------------------------------------------------------


def test_recall_builds_body_and_shapes_bare_list(captured):
    """Recall posts top-level ids + top_k and shapes a bare-list response."""
    # mem0 search returns a bare list — _shape_results must tolerate it.
    captured['search'] = [
        {'id': 'm1', 'memory': 'User is vegetarian', 'score': 0.91, 'categories': ['food']},
        {'id': 'm2', 'memory': 'Tokyo trip', 'score': 0.62},
    ]
    inst = _instance(_make_global())

    out = inst.recall({'query': 'what does the user eat?'})

    assert out['success'] is True
    assert out['count'] == 2
    assert out['results'][0]['memory'] == 'User is vegetarian'

    call = captured['calls'][-1]
    assert call['url'].endswith('/v1/memories/search/')
    p = call['payload']
    assert p['query'] == 'what does the user eat?'
    assert p['top_k'] == 10
    # Entity ids TOP-LEVEL in the body (same as add()); never `filters`.
    assert p['user_id'] == 'alice'
    assert 'filters' not in p


def test_recall_run_id_from_args_passed_top_level(captured):
    """per-call run_id is added top-level to the search body."""
    captured['search'] = []
    inst = _instance(_make_global())
    out = inst.recall({'query': 'trip', 'run_id': 'run_x'})
    assert out['success'] is True
    p = captured['calls'][-1]['payload']
    assert p['user_id'] == 'alice'
    assert p['run_id'] == 'run_x'
    assert 'filters' not in p


def test_recall_requires_query(captured):
    """Recall errors (no HTTP call) on an empty query."""
    inst = _instance(_make_global())
    out = inst.recall({'query': '   '})
    assert out['success'] is False
    assert captured['calls'] == []


def test_recall_requires_scope(captured):
    """Recall errors (no HTTP call) when no scope is set."""
    inst = _instance(_make_global(user_id='', agent_id='', run_id='', app_id=''))
    out = inst.recall({'query': 'anything'})
    assert out['success'] is False
    assert 'scope' in out['error']
    assert captured['calls'] == []
