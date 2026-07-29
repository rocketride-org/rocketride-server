# =============================================================================
# RocketRide Engine
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

"""Unit tests for tool_insforge pure helpers and tool guards (no network)."""

from __future__ import annotations

import importlib
import json
import sys
from pathlib import Path
from unittest.mock import MagicMock

import pytest

# ---------------------------------------------------------------------------
# Bootstrap: when run under a bare interpreter that lacks the engine runtime
# (rocketlib, ai.common, requests), inject lightweight stubs ONLY for modules
# that are not already present, import the modules under test, then REMOVE the
# stubs we added. Restoring is essential: under the full `builder nodes:test-full`
# run these modules are real and shared across the whole pytest session, so a
# leaked MagicMock stub would break unrelated nodes' tests.
# ---------------------------------------------------------------------------

# Add nodes/src to sys.path so `nodes.tool_insforge.*` is resolvable.
_NODES_SRC = Path(__file__).resolve().parents[1] / 'src'
if str(_NODES_SRC) not in sys.path:
    sys.path.insert(0, str(_NODES_SRC))

_SERVICES_PATH = _NODES_SRC / 'nodes' / 'tool_insforge' / 'services.json'


def _require_dict(value, **_kwargs):
    """Stand-in for ai.common.utils.require_dict."""
    if not isinstance(value, dict):
        raise ValueError('expected an object')
    return value


class _StubRequestException(Exception):
    """Mirrors requests.exceptions.RequestException as the base of the tree."""


class _StubHTTPError(_StubRequestException):
    response = None


class _StubTimeout(_StubRequestException):
    pass


class _StubConnectionError(_StubRequestException):
    pass


def _build_import_stubs():
    """Return {module_name: stub} for the deps needed only to import the modules."""
    rocketlib = MagicMock()
    rocketlib.IInstanceBase = object  # must be a real class for inheritance
    rocketlib.IGlobalBase = object
    rocketlib.tool_function = lambda **kwargs: lambda f: f  # pass-through decorator
    rocketlib.debug = lambda *a, **kw: None
    rocketlib.error = lambda *a, **kw: None
    rocketlib.warning = lambda *a, **kw: None
    rocketlib.OPEN_MODE = MagicMock()

    depends = MagicMock()
    depends.depends = lambda *a, **kw: None

    ai_common_utils = MagicMock()
    ai_common_utils.normalize_tool_input = lambda args, **kw: args if isinstance(args, dict) else {}
    ai_common_utils.require_str = lambda args, key, **kw: str(args[key])
    ai_common_utils.require_dict = _require_dict
    ai_common_utils.parse_bool = lambda v: bool(v)
    ai_common_utils.get_with_retry = lambda *a, **kw: None
    ai_common_utils.request_with_retry = lambda *a, **kw: None

    requests = MagicMock()
    requests.exceptions = MagicMock()
    # Real classes, in requests' own hierarchy: the client catches the specific
    # subclasses before falling back to RequestException, so flat Exception
    # aliases would let the fallback swallow cases the specific handlers own.
    requests.exceptions.RequestException = _StubRequestException
    requests.exceptions.HTTPError = _StubHTTPError
    requests.exceptions.Timeout = _StubTimeout
    requests.exceptions.ConnectionError = _StubConnectionError

    requests_status_codes = MagicMock()
    requests_status_codes.codes = MagicMock()

    return {
        'rocketlib': rocketlib,
        'depends': depends,
        'ai': MagicMock(),
        'ai.common': MagicMock(),
        'ai.common.utils': ai_common_utils,
        'ai.common.config': MagicMock(),
        'requests': requests,
        'requests.status_codes': requests_status_codes,
    }


_added_stubs = []
for _name, _stub in _build_import_stubs().items():
    if _name not in sys.modules:
        sys.modules[_name] = _stub
        _added_stubs.append(_name)

client = importlib.import_module('nodes.tool_insforge.insforge_client')
global_mod = importlib.import_module('nodes.tool_insforge.IGlobal')
instance_mod = importlib.import_module('nodes.tool_insforge.IInstance')

# Drop the stubs we injected so they never leak into the shared pytest session.
for _name in _added_stubs:
    sys.modules.pop(_name, None)


@pytest.fixture
def depends_stub():
    """Provide the engine's `depends` module for the duration of one test.

    ``beginGlobal`` imports ``load_depends`` lazily at call time, which is after
    the import-time stubs above have been removed. Restores the previous state
    so nothing leaks into the shared session.
    """
    if 'depends' in sys.modules:
        yield
        return

    stub = MagicMock()
    stub.load_depends = lambda *a, **kw: None
    sys.modules['depends'] = stub
    try:
        yield
    finally:
        sys.modules.pop('depends', None)


def _instance(*, allow_writes: bool):
    """Build an IInstance with just the global state the tools read."""
    inst = instance_mod.IInstance()
    inst.IGlobal = MagicMock(
        base_url='https://demo.insforge.app',
        token='key-123',
        allow_writes=allow_writes,
    )
    return inst


# ---------------------------------------------------------------------------
# services.json
# ---------------------------------------------------------------------------


def test_services_shape_fields_are_all_declared():
    service = json.loads(_SERVICES_PATH.read_text(encoding='utf-8'))
    declared = set(service['fields'])
    shape_props = set(service['shape'][0]['properties'])

    # 'type' is engine-provided, every other shape entry must define a field.
    assert shape_props - {'type'} <= declared


def test_services_defaults_to_read_only():
    service = json.loads(_SERVICES_PATH.read_text(encoding='utf-8'))
    assert service['fields']['insforge.allow_writes']['default'] is False
    assert service['preconfig']['profiles']['default']['allow_writes'] is False


def test_services_marks_api_key_secure():
    service = json.loads(_SERVICES_PATH.read_text(encoding='utf-8'))
    assert service['fields']['insforge.api_key']['secure'] is True


def test_services_is_a_lane_less_tool():
    service = json.loads(_SERVICES_PATH.read_text(encoding='utf-8'))
    assert service['classType'] == ['tool']
    assert service['lanes'] == {}


# ---------------------------------------------------------------------------
# normalize_base_url
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    'raw,expected',
    [
        ('https://demo.insforge.app', 'https://demo.insforge.app'),
        ('https://demo.insforge.app/', 'https://demo.insforge.app'),
        ('https://demo.insforge.app/api/', 'https://demo.insforge.app'),
        ('demo.insforge.app', 'https://demo.insforge.app'),
        ('  https://demo.insforge.app  ', 'https://demo.insforge.app'),
        ('http://insforge.internal:7130', 'http://insforge.internal:7130'),
    ],
)
def test_normalize_base_url_reduces_to_origin(raw, expected):
    assert client.normalize_base_url(raw) == expected


@pytest.mark.parametrize('bad', ['', '   ', 'ftp://demo.insforge.app', 'https://'])
def test_normalize_base_url_rejects_bad_urls(bad):
    with pytest.raises(ValueError):
        client.normalize_base_url(bad)


# ---------------------------------------------------------------------------
# encode_filters
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    'filters,expected',
    [
        ({'status': 'eq.active'}, {'status': 'eq.active'}),
        ({'views': 'gte.100'}, {'views': 'gte.100'}),
        ({'id': 'in.(1,2,3)'}, {'id': 'in.(1,2,3)'}),
        ({'deleted_at': 'is.null'}, {'deleted_at': 'is.null'}),
        ({'active': 'is.TRUE'}, {'active': 'is.TRUE'}),  # is-value check is case-insensitive
        ({'name': 'eq.a,b'}, {'name': 'eq.a,b'}),  # a comma is a legal value for eq
        ({'meta->>role': 'eq.admin'}, {'meta->>role': 'eq.admin'}),
        (None, {}),
        ({}, {}),
    ],
)
def test_encode_filters_passes_documented_grammar(filters, expected):
    assert client.encode_filters(filters) == expected


@pytest.mark.parametrize(
    'bad',
    [
        {'status': 'active'},  # no operator
        {'status': 'bogus.x'},  # unknown operator
        {'status': 'eq.'},  # no value
        {'bad column': 'eq.x'},  # space in identifier
        {'a;b': 'eq.x'},  # punctuation in identifier
        {'id': 'in.1'},  # 'in' without a parenthesised set
        {'id': 'in.1,2,3'},  # the mistake a model actually makes
        {'id': 'in.(1,2'},  # unbalanced
        {'deleted_at': 'is.nil'},  # not a PostgREST 'is' value
        {'deleted_at': 'is.1'},
        'not-a-dict',
        ['not-a-dict'],
    ],
)
def test_encode_filters_rejects_malformed_filters(bad):
    with pytest.raises(ValueError):
        client.encode_filters(bad)


def test_encode_filters_error_names_the_column():
    """A rejected filter has to say which one, or an agent cannot self-correct."""
    with pytest.raises(ValueError, match='tags'):
        client.encode_filters({'status': 'eq.active', 'tags': 'in.a,b'})


# ---------------------------------------------------------------------------
# call() transport-error mapping
# ---------------------------------------------------------------------------


def test_call_maps_uncommon_transport_errors_to_valueerror(monkeypatch):
    """A RequestException with no specific handler still reaches the agent as text.

    ChunkedEncodingError and friends are rare enough to have no dedicated
    branch, but a raw traceback out of a tool call is not something an agent
    can report or retry against.
    """
    exc_type = client.requests.exceptions.RequestException

    def boom(*a, **kw):
        raise exc_type('connection broken')

    monkeypatch.setattr(client.requests, 'post', boom)
    with pytest.raises(ValueError, match='InsForge request failed'):
        client.call('k', 'https://p.insforge.app', 'POST', '/api/database/records/t')


# ---------------------------------------------------------------------------
# Path-safety guards
# ---------------------------------------------------------------------------


@pytest.mark.parametrize('name', ['posts', 'user_profiles', '_internal', 'a1'])
def test_require_identifier_accepts_bare_names(name):
    assert client.require_identifier(name, kind='table') == name


@pytest.mark.parametrize('bad', ['../secrets', 'a/b', '', '  ', 'pg posts', '"quoted"', 'schema.table', '1abc'])
def test_require_identifier_rejects_path_and_quoting(bad):
    with pytest.raises(ValueError):
        client.require_identifier(bad, kind='table')


def test_require_object_key_allows_nested_paths():
    assert client.require_object_key('docs/report.pdf') == 'docs/report.pdf'


def test_require_object_key_escapes_each_segment():
    assert client.require_object_key('my docs/a+b.pdf') == 'my%20docs/a%2Bb.pdf'


@pytest.mark.parametrize('bad', ['/absolute.txt', '../etc/passwd', 'a/../b', 'a/./b', '', '   '])
def test_require_object_key_rejects_traversal(bad):
    with pytest.raises(ValueError):
        client.require_object_key(bad)


# ---------------------------------------------------------------------------
# clamp_limit / rows_envelope
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    'value,expected',
    [(None, 100), ('', 100), (5, 5), ('5', 5), (0, 1), (-3, 1), (10**6, client.MAX_LIMIT)],
)
def test_clamp_limit_bounds_the_row_count(value, expected):
    assert client.clamp_limit(value) == expected


def test_clamp_limit_rejects_non_numeric():
    with pytest.raises(ValueError):
        client.clamp_limit('abc')


def test_rows_envelope_shape():
    assert client.rows_envelope([{'a': 1}], query={'table': 't'}) == {
        'count': 1,
        'rows': [{'a': 1}],
        'query': {'table': 't'},
    }


def test_rows_envelope_normalizes_none_and_scalars():
    assert client.rows_envelope(None, query={})['count'] == 0
    assert client.rows_envelope({'a': 1}, query={})['rows'] == [{'a': 1}]


# ---------------------------------------------------------------------------
# Write gating
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    'tool,args',
    [
        ('records_insert', {'table': 'posts', 'records': [{'a': 1}]}),
        ('records_upsert', {'table': 'posts', 'records': [{'a': 1}]}),
        ('records_update', {'table': 'posts', 'values': {'a': 1}, 'filters': {'id': 'eq.1'}}),
        ('records_delete', {'table': 'posts', 'filters': {'id': 'eq.1'}}),
        ('rpc_call', {'function': 'do_thing'}),
        ('storage_delete_object', {'bucket': 'files', 'object_key': 'a.txt'}),
    ],
)
def test_mutating_tools_are_blocked_when_writes_disabled(tool, args):
    inst = _instance(allow_writes=False)
    with pytest.raises(ValueError, match='read-only'):
        getattr(inst, tool)(args)


def test_write_denial_tells_the_agent_not_to_retry():
    inst = _instance(allow_writes=False)
    with pytest.raises(ValueError, match='Do not retry'):
        inst.records_insert({'table': 'posts', 'records': [{'a': 1}]})


# ---------------------------------------------------------------------------
# Unfiltered write refusal
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    'tool,args',
    [
        ('records_update', {'table': 'posts', 'values': {'a': 1}, 'filters': {}}),
        ('records_update', {'table': 'posts', 'values': {'a': 1}}),
        ('records_delete', {'table': 'posts', 'filters': {}}),
        ('records_delete', {'table': 'posts'}),
    ],
)
def test_update_and_delete_refuse_to_run_unfiltered(tool, args):
    inst = _instance(allow_writes=True)
    with pytest.raises(ValueError, match='at least one filter'):
        getattr(inst, tool)(args)


def test_insert_rejects_empty_record_list():
    inst = _instance(allow_writes=True)
    with pytest.raises(ValueError, match='non-empty array'):
        inst.records_insert({'table': 'posts', 'records': []})


def test_update_rejects_empty_value_set():
    inst = _instance(allow_writes=True)
    with pytest.raises(ValueError, match='at least one column'):
        inst.records_update({'table': 'posts', 'values': {}, 'filters': {'id': 'eq.1'}})


# ---------------------------------------------------------------------------
# IGlobal: config / env resolution
# ---------------------------------------------------------------------------


def test_begin_global_falls_back_to_env(monkeypatch, depends_stub):
    monkeypatch.setenv('ROCKETRIDE_INSFORGE_URL', 'https://env.insforge.app')
    monkeypatch.setenv('ROCKETRIDE_INSFORGE_KEY', 'env-key')
    monkeypatch.setattr(global_mod.Config, 'getNodeConfig', lambda *a, **kw: {'project_url': '  ', 'api_key': ''})

    glb = global_mod.IGlobal()
    glb.IEndpoint = MagicMock()
    glb.IEndpoint.endpoint.openMode = object()  # not CONFIG, so it runs the real path
    glb.glb = MagicMock(logicalType='tool_insforge', connConfig={})

    glb.beginGlobal()

    assert glb.base_url == 'https://env.insforge.app'
    assert glb.token == 'env-key'
    assert glb.allow_writes is False


def test_begin_global_prefers_node_config_over_env(monkeypatch, depends_stub):
    monkeypatch.setenv('ROCKETRIDE_INSFORGE_URL', 'https://env.insforge.app')
    monkeypatch.setenv('ROCKETRIDE_INSFORGE_KEY', 'env-key')
    monkeypatch.setattr(
        global_mod.Config,
        'getNodeConfig',
        lambda *a, **kw: {'project_url': 'https://cfg.insforge.app', 'api_key': 'cfg-key', 'allow_writes': True},
    )

    glb = global_mod.IGlobal()
    glb.IEndpoint = MagicMock()
    glb.IEndpoint.endpoint.openMode = object()
    glb.glb = MagicMock(logicalType='tool_insforge', connConfig={})

    glb.beginGlobal()

    assert glb.base_url == 'https://cfg.insforge.app'
    assert glb.token == 'cfg-key'
    assert glb.allow_writes is True


def test_begin_global_requires_a_key(monkeypatch, depends_stub):
    monkeypatch.delenv('ROCKETRIDE_INSFORGE_KEY', raising=False)
    monkeypatch.setattr(
        global_mod.Config,
        'getNodeConfig',
        lambda *a, **kw: {'project_url': 'https://cfg.insforge.app', 'api_key': ''},
    )

    glb = global_mod.IGlobal()
    glb.IEndpoint = MagicMock()
    glb.IEndpoint.endpoint.openMode = object()
    glb.glb = MagicMock(logicalType='tool_insforge', connConfig={})

    with pytest.raises(Exception, match='api_key is required'):
        glb.beginGlobal()
