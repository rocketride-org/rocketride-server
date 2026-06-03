# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Unit tests for the xtrace_memory node.

Pure-Python: no server, no engine, no real HTTP. The node module is imported
under composable stubs for ``rocketlib`` and ``ai.common.*`` so the relative
``from .IGlobal import IGlobal`` resolves without the engine runtime, and the
``requests`` call is replaced by patching the module's ``_request_with_retry``.

Covers:
* ``_split_group_ids`` — comma-string / list / empty parsing.
* ``_coerce_messages`` — messages array, ``content`` fallback, role default.
* ``remember`` — payload shape, scope/conv defaults, terminal vs missing user.
* ``recall`` — payload shape, scope requirement, response shaping.
"""

from __future__ import annotations

import sys
import types
from pathlib import Path

import pytest

_NODE_DIR = Path(__file__).resolve().parent.parent.parent / 'src' / 'nodes' / 'tool_xtrace_memory'


# ---------------------------------------------------------------------------
# Composable import scaffolding (augments existing stubs, never clobbers)
# ---------------------------------------------------------------------------


def _tool_function(**_meta):
    def wrap(fn):
        fn.__tool_meta__ = _meta
        return fn

    return wrap


def _ensure_rocketlib() -> None:
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
    return args if isinstance(args, dict) else {}


def _ensure_ai_common() -> None:
    """Create minimal ``ai.common.*`` stubs only when absent.

    Never overwrites a real/existing module attribute — that would pollute
    other node tests in the same session. Deterministic behavior for THIS
    node is pinned locally after import (see below), not globally here.
    """
    for name in ('ai', 'ai.common', 'ai.common.utils', 'ai.common.config'):
        if name not in sys.modules:
            sys.modules[name] = types.ModuleType(name)
    if not hasattr(sys.modules['ai.common.utils'], 'normalize_tool_input'):
        sys.modules['ai.common.utils'].normalize_tool_input = _passthrough
    if not hasattr(sys.modules['ai.common.config'], 'Config'):

        class _Config:
            @staticmethod
            def getNodeConfig(*_a, **_k):
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
    mod.exceptions = exc
    mod.request = lambda *a, **k: None
    sys.modules['requests'] = mod
    sys.modules['requests.exceptions'] = exc


def _ensure_tenacity() -> None:
    """Stub ``tenacity`` if unavailable — the retry layer is patched out in tests."""
    if 'tenacity' in sys.modules:
        return
    mod = types.ModuleType('tenacity')
    # Retrying(...)(fn) just calls fn once; tests patch _request_with_retry anyway.
    mod.Retrying = lambda **_kw: lambda fn, *a, **k: fn(*a, **k)
    mod.stop_after_attempt = lambda *a, **k: None
    mod.wait_exponential = lambda *a, **k: None
    mod.retry_if_exception = lambda *a, **k: None
    sys.modules['tenacity'] = mod


def _ensure_pkg() -> None:
    if 'tool_xtrace_memory' not in sys.modules:
        pkg = types.ModuleType('tool_xtrace_memory')
        pkg.__path__ = [str(_NODE_DIR)]
        sys.modules['tool_xtrace_memory'] = pkg


_ensure_rocketlib()
_ensure_ai_common()
_ensure_requests()
_ensure_tenacity()
_ensure_pkg()

from tool_xtrace_memory import IInstance as IInstanceMod  # noqa: E402
from tool_xtrace_memory.IInstance import IInstance, _coerce_messages  # noqa: E402
from tool_xtrace_memory.IGlobal import IGlobal, _split_group_ids  # noqa: E402

# Pin the input normalizer locally so behavior is deterministic regardless of
# whatever ``ai.common.utils`` resolved to in this session (real or MagicMock).
IInstanceMod.normalize_tool_input = _passthrough


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _make_global(**overrides):
    glb = IGlobal()
    glb.api_key = 'xtk_test'
    glb.org_id = 'org_test'
    glb.base_url = 'https://api.production.xtrace.ai'
    glb.user_id = 'alice'
    glb.agent_id = ''
    glb.app_id = ''
    glb.group_ids = []
    glb.wait = True
    glb.ingest_timeout = 30
    glb.extract_artifacts = False
    glb.search_mode = 'compose'
    glb.search_limit = 10
    for k, v in overrides.items():
        setattr(glb, k, v)
    return glb


@pytest.fixture
def captured(monkeypatch):
    """Patch the HTTP layer; record the last call and return a canned body."""
    state = {'calls': [], 'response': {}}

    def fake_request(method, url, headers, *, payload=None, params=None, **kw):
        state['calls'].append(
            {
                'method': method,
                'url': url,
                'headers': headers,
                'payload': payload,
                'params': params,
                'idempotent': kw.get('idempotent', True),
            }
        )
        return state['response']

    monkeypatch.setattr(IInstanceMod, '_request_with_retry', fake_request)
    return state


def _instance(glb):
    inst = IInstance()
    inst.IGlobal = glb
    inst._conv_id = 'conv_fixed'
    return inst


# ---------------------------------------------------------------------------
# Pure helpers
# ---------------------------------------------------------------------------


def test_split_group_ids_variants():
    assert _split_group_ids('grp_a, grp_b ,grp_c') == ['grp_a', 'grp_b', 'grp_c']
    assert _split_group_ids(['grp_a', ' grp_b ']) == ['grp_a', 'grp_b']
    assert _split_group_ids('') == []
    assert _split_group_ids(None) == []


def test_coerce_messages_variants():
    assert _coerce_messages([{'role': 'user', 'content': 'hi'}], None, None) == [{'role': 'user', 'content': 'hi'}]
    # content fallback with default role
    assert _coerce_messages(None, 'I am vegetarian', None) == [{'role': 'user', 'content': 'I am vegetarian'}]
    # explicit role honored
    assert _coerce_messages(None, 'noted', 'assistant') == [{'role': 'assistant', 'content': 'noted'}]
    # blank / empty drops
    assert _coerce_messages(None, '   ', None) == []
    assert _coerce_messages([{'role': 'user', 'content': ''}], None, None) == []


# ---------------------------------------------------------------------------
# remember
# ---------------------------------------------------------------------------


def test_remember_builds_payload_and_returns_terminal(captured):
    captured['response'] = {
        'id': 'job_1',
        'status': 'succeeded',
        'result': {'memories_created': [{'id': 'm1', 'type': 'fact', 'text': 'User is vegetarian'}]},
    }
    inst = _instance(_make_global(extract_artifacts=True, group_ids=['grp_x']))

    out = inst.remember({'content': 'I am vegetarian'})

    assert out['success'] is True
    assert out['status'] == 'succeeded'
    assert out['job_id'] == 'job_1'
    assert out['memories_created'] == [{'id': 'm1', 'type': 'fact', 'text': 'User is vegetarian'}]

    call = captured['calls'][-1]
    assert call['method'] == 'POST'
    assert call['url'].endswith('/v1/memories')
    assert call['params'] == {'wait': 'true'}
    assert call['headers']['x-api-key'] == 'xtk_test'
    assert call['headers']['X-Org-Id'] == 'org_test'
    p = call['payload']
    assert p['messages'] == [{'role': 'user', 'content': 'I am vegetarian'}]
    assert p['user_id'] == 'alice'
    assert p['conv_id'] == 'conv_fixed'
    assert p['extract_artifacts'] is True
    assert p['group_ids'] == ['grp_x']
    # ingest is a non-idempotent write — must not auto-retry on 5xx/timeout
    assert call['idempotent'] is False


def test_remember_requires_user_id(captured):
    inst = _instance(_make_global(user_id=''))
    out = inst.remember({'content': 'hello'})
    assert out['success'] is False
    assert 'user_id' in out['error']
    assert captured['calls'] == []  # never hit the network


def test_remember_requires_content(captured):
    inst = _instance(_make_global())
    out = inst.remember({})
    assert out['success'] is False
    assert captured['calls'] == []


# ---------------------------------------------------------------------------
# recall
# ---------------------------------------------------------------------------


def test_recall_builds_payload_and_shapes_results(captured):
    captured['response'] = {
        'mode': 'compose',
        'context': '## What we know\n- User is vegetarian',
        'data': [
            {'id': 'm1', 'type': 'fact', 'text': 'User is vegetarian', 'score': 0.91},
            {'id': 'm2', 'type': 'episode', 'text': 'Tokyo trip', 'score': 0.62},
        ],
    }
    inst = _instance(_make_global())

    out = inst.recall({'query': 'what does the user eat?'})

    assert out['success'] is True
    assert out['context'].startswith('## What we know')
    assert out['count'] == 2
    assert out['results'][0] == {'id': 'm1', 'type': 'fact', 'text': 'User is vegetarian', 'score': 0.91}

    call = captured['calls'][-1]
    assert call['url'].endswith('/v1/memories/search')
    p = call['payload']
    assert p['query'] == 'what does the user eat?'
    assert p['mode'] == 'compose'
    assert p['limit'] == 10
    assert p['user_id'] == 'alice'


def test_recall_requires_query(captured):
    inst = _instance(_make_global())
    out = inst.recall({'query': '   '})
    assert out['success'] is False
    assert captured['calls'] == []


def test_recall_requires_scope(captured):
    inst = _instance(_make_global(user_id='', group_ids=[], agent_id='', app_id=''))
    out = inst.recall({'query': 'anything'})
    assert out['success'] is False
    assert 'scope' in out['error']
    assert captured['calls'] == []


def test_recall_group_scope_from_args(captured):
    captured['response'] = {'mode': 'retrieve', 'context': None, 'data': []}
    inst = _instance(_make_global(user_id=''))
    out = inst.recall({'query': 'trip', 'group_ids': ['grp_tokyo'], 'mode': 'retrieve'})
    assert out['success'] is True
    assert out['context'] == ''
    p = captured['calls'][-1]['payload']
    assert p['group_ids'] == ['grp_tokyo']
    assert p['mode'] == 'retrieve'
    assert 'user_id' not in p
