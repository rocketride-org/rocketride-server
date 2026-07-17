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

"""Unit tests for tool_n8n pure helpers (no network)."""

from __future__ import annotations

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
# leaked MagicMock stub would break unrelated nodes' tests. The pure helpers
# under test hold no runtime dependency on the stubbed modules, so dropping the
# stubs after import is safe.
# ---------------------------------------------------------------------------

import importlib

# Add nodes/src to sys.path so `nodes.tool_n8n.*` is resolvable.
_NODES_SRC = Path(__file__).resolve().parents[1] / 'src'
if str(_NODES_SRC) not in sys.path:
    sys.path.insert(0, str(_NODES_SRC))


_SERVICES_PATH = _NODES_SRC / 'nodes' / 'tool_n8n' / 'services.json'


def _conditional_properties(field):
    """Return each conditional value mapped to its child field names."""
    result = {}
    for conditional in field['conditional']:
        values = conditional['value'] if isinstance(conditional['value'], list) else [conditional['value']]
        for value in values:
            result[value] = conditional['properties']
    return result


def test_services_schema_only_shows_relevant_n8n_fields():
    service = json.loads(_SERVICES_PATH.read_text(encoding='utf-8'))
    fields = service['fields']

    assert service['shape'][0]['ui']['ui:options']['compactDescriptions'] is True
    assert fields['tool_n8n.apiKey']['optional'] is True
    assert _conditional_properties(fields['tool_n8n.mode']) == {
        'sync': ['tool_n8n.syncTimeout'],
        'async': ['tool_n8n.asyncTimeout'],
    }
    assert _conditional_properties(fields['tool_n8n.webhookAuth']) == {
        'none': [],
        'header': ['tool_n8n.webhookHeaderName', 'tool_n8n.webhookHeaderValue'],
        'basic': ['tool_n8n.webhookUser', 'tool_n8n.webhookPassword'],
        'bearer': ['tool_n8n.webhookToken'],
        'jwt': ['tool_n8n.webhookToken'],
    }
    assert all(
        not isinstance(conditional['value'], list) for conditional in fields['tool_n8n.webhookAuth']['conditional']
    )

    conditional_fields = {
        'tool_n8n.syncTimeout',
        'tool_n8n.asyncTimeout',
        'tool_n8n.webhookHeaderName',
        'tool_n8n.webhookHeaderValue',
        'tool_n8n.webhookUser',
        'tool_n8n.webhookPassword',
        'tool_n8n.webhookToken',
    }
    top_level = set(service['shape'][0]['properties'])
    assert conditional_fields.isdisjoint(top_level)
    assert all(fields[field].get('optional') is not True for field in conditional_fields)


def _build_import_stubs():
    """Return {module_name: stub} for the deps needed only to import the modules."""
    rocketlib = MagicMock()
    rocketlib.IInstanceBase = object  # must be a real class for inheritance
    rocketlib.IGlobalBase = object
    rocketlib.Entry = object
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

    ai_common_schema = MagicMock()
    ai_common_schema.Answer = MagicMock
    ai_common_schema.Doc = MagicMock

    requests = MagicMock()
    requests.exceptions = MagicMock()
    # Use real exception classes so except clauses can actually catch them.
    requests.exceptions.Timeout = TimeoutError
    requests.exceptions.ConnectionError = ConnectionError
    requests.exceptions.RequestException = Exception
    requests.RequestException = Exception

    return {
        'rocketlib': rocketlib,
        'depends': depends,
        'ai': MagicMock(),
        'ai.common': MagicMock(),
        'ai.common.utils': ai_common_utils,
        'ai.common.schema': ai_common_schema,
        'ai.common.config': MagicMock(),
        'requests': requests,
    }


_added_stubs = []
for _name, _stub in _build_import_stubs().items():
    if _name not in sys.modules:
        sys.modules[_name] = _stub
        _added_stubs.append(_name)

client = importlib.import_module('nodes.tool_n8n.n8n_client')
global_mod = importlib.import_module('nodes.tool_n8n.IGlobal')
instance_mod = importlib.import_module('nodes.tool_n8n.IInstance')

# Drop the stubs we injected so they never leak into the shared pytest session.
for _name in _added_stubs:
    sys.modules.pop(_name, None)


# ---------------------------------------------------------------------------
# IGlobal: config/env loading
# ---------------------------------------------------------------------------


def test_begin_global_uses_workflow_env_when_config_workflow_empty(monkeypatch):
    monkeypatch.setenv('ROCKETRIDE_N8N_WORKFLOW', 'env-webhook-path')
    monkeypatch.setattr(
        global_mod.Config,
        'getNodeConfig',
        lambda *a, **kw: {'baseUrl': 'http://n8n:5678', 'workflow': '   '},
    )

    glb = global_mod.IGlobal()
    glb.IEndpoint = MagicMock()
    glb.IEndpoint.endpoint.openMode = object()
    glb.glb = MagicMock(logicalType='tool_n8n', connConfig={})

    glb.beginGlobal()

    assert glb.default_workflow == 'env-webhook-path'


# ---------------------------------------------------------------------------
# n8n_client: started-ack detection
# ---------------------------------------------------------------------------


def test_is_started_ack_detects_default_ack():
    assert client.is_started_ack({'message': 'Workflow was started'}) is True
    assert client.is_started_ack({'message': 'workflow was started'}) is True


def test_is_started_ack_rejects_real_results():
    assert client.is_started_ack({'message': 'done', 'value': 1}) is False
    assert client.is_started_ack({'result': 42}) is False
    assert client.is_started_ack('Workflow was started') is False  # string body, not the ack dict
    assert client.is_started_ack(None) is False
    assert client.is_started_ack([]) is False


# ---------------------------------------------------------------------------
# n8n_client: webhook auth mapping
# ---------------------------------------------------------------------------


def test_apply_webhook_auth_none():
    headers, basic = client._apply_webhook_auth(None)
    assert headers == {} and basic is None


def test_apply_webhook_auth_header():
    headers, basic = client._apply_webhook_auth({'type': 'header', 'name': 'X-Auth', 'value': 'secret'})
    assert headers == {'X-Auth': 'secret'} and basic is None


def test_apply_webhook_auth_header_without_name_is_noop():
    headers, basic = client._apply_webhook_auth({'type': 'header', 'name': '', 'value': 'secret'})
    assert headers == {} and basic is None


def test_apply_webhook_auth_basic():
    headers, basic = client._apply_webhook_auth({'type': 'basic', 'user': 'u', 'password': 'p'})
    assert headers == {} and basic == ('u', 'p')


# ---------------------------------------------------------------------------
# n8n_client: deploy-aware unreachable message
# ---------------------------------------------------------------------------


def test_unreachable_message_plain_when_not_local():
    msg = client._unreachable_message('https://n8n.example.com', ConnectionError())
    assert 'n8n.example.com' in msg
    assert 'host.docker.internal' not in msg


def test_unreachable_message_suggests_docker_fix_for_localhost_in_container(monkeypatch):
    monkeypatch.setattr(client, '_in_container', lambda: True)
    msg = client._unreachable_message('http://localhost:5678', ConnectionError())
    assert 'host.docker.internal' in msg


def test_unreachable_message_no_docker_hint_outside_container(monkeypatch):
    monkeypatch.setattr(client, '_in_container', lambda: False)
    msg = client._unreachable_message('http://localhost:5678', ConnectionError())
    assert 'host.docker.internal' not in msg


# ---------------------------------------------------------------------------
# n8n_client: response shapers
# ---------------------------------------------------------------------------


def test_clean_workflow_extracts_webhook_paths():
    workflow = {
        'id': 'wf1',
        'name': 'Enrich',
        'active': True,
        'tags': [{'name': 'prod'}],
        'nodes': [
            {'type': 'n8n-nodes-base.webhook', 'parameters': {'path': 'enrich-invoice'}},
            {'type': 'n8n-nodes-base.set', 'parameters': {}},
        ],
    }
    shaped = client.clean_workflow(workflow)
    assert shaped['id'] == 'wf1'
    assert shaped['active'] is True
    assert shaped['tags'] == ['prod']
    assert shaped['webhookPaths'] == ['enrich-invoice']


def test_clean_workflow_handles_non_dict():
    assert client.clean_workflow(None) == {}
    assert client.clean_workflow('nope') == {}


def test_clean_execution_keeps_data_only_when_present():
    shaped = client.clean_execution({'id': '9', 'status': 'success'})
    assert 'data' not in shaped
    shaped = client.clean_execution({'id': '9', 'status': 'success', 'data': {'out': 1}})
    assert shaped['data'] == {'out': 1}


def test_extract_webhook_paths_skips_malformed_nodes():
    workflow = {'nodes': ['oops', None, {'type': 'n8n-nodes-base.webhook', 'parameters': {}}]}
    assert client.extract_webhook_paths(workflow) == []


# ---------------------------------------------------------------------------
# IInstance: agent-supplied workflow path sanitisation (SSRF guard)
# ---------------------------------------------------------------------------


def test_safe_path_accepts_plain_paths():
    safe = instance_mod.IInstance._safe_path
    assert safe('enrich-invoice') == 'enrich-invoice'
    assert safe('/enrich-invoice') == 'enrich-invoice'
    assert safe('a/b-c') == 'a/b-c'
    # Legitimate multi-segment webhook paths still pass (only leading slashes trimmed).
    assert safe('webhook/sub/deep') == 'webhook/sub/deep'
    assert safe('/a/b/c') == 'a/b/c'


@pytest.mark.parametrize(
    'bad',
    [
        '',
        '   ',
        'http://evil.example.com/webhook/x',
        'https://169.254.169.254/latest/meta-data',
        'a path with spaces',
        'path\nwith\nnewlines',
        # Path traversal / dot segments.
        '.',
        '..',
        '../api/v1/workflows',
        './x',
        'a/../b',
        'a/./b',
        # Query / fragment / backslash smuggling.
        'foo?bar=1',
        'frag#x',
        'back\\slash',
    ],
)
def test_safe_path_rejects_urls_and_whitespace(bad):
    with pytest.raises(ValueError):
        instance_mod.IInstance._safe_path(bad)


# ---------------------------------------------------------------------------
# n8n_client: async polling helpers
# ---------------------------------------------------------------------------


def test_find_workflow_id_by_path_matches(monkeypatch):
    workflows = {
        'data': [
            {'id': 'a', 'nodes': [{'type': 'n8n-nodes-base.webhook', 'parameters': {'path': 'other'}}]},
            {'id': 'b', 'nodes': [{'type': 'n8n-nodes-base.webhook', 'parameters': {'path': 'enrich'}}]},
        ]
    }
    monkeypatch.setattr(client, 'call', lambda *a, **kw: workflows)
    assert client.find_workflow_id_by_path('http://x', 'key', 'enrich') == 'b'
    assert client.find_workflow_id_by_path('http://x', 'key', '/enrich') == 'b'


def test_find_workflow_id_by_path_no_match_raises(monkeypatch):
    monkeypatch.setattr(client, 'call', lambda *a, **kw: {'data': []})
    with pytest.raises(ValueError, match='No workflow with webhook path'):
        client.find_workflow_id_by_path('http://x', 'key', 'missing')


def _fake_clock(monkeypatch, *, step=1.0):
    """Replace time.monotonic/time.sleep on the client module with a fake clock."""
    state = {'now': 0.0}

    def monotonic():
        return state['now']

    def sleep(seconds):
        state['now'] += max(seconds, step)

    monkeypatch.setattr(client.time, 'monotonic', monotonic)
    monkeypatch.setattr(client.time, 'sleep', sleep)
    return state


def test_wait_for_execution_succeeds_on_later_poll(monkeypatch):
    _fake_clock(monkeypatch)
    polls = {'n': 0}

    def fake_call(base_url, api_key, method, path, **kw):
        if path == '/executions':
            polls['n'] += 1
            if polls['n'] < 3:
                return {'data': [{'id': '7', 'status': 'running', 'startedAt': '2026-06-10T00:00:01Z'}]}
            return {'data': [{'id': '7', 'status': 'success', 'startedAt': '2026-06-10T00:00:01Z'}]}
        assert path == '/executions/7'
        return {'id': '7', 'status': 'success', 'data': {'echo': 'cid-123'}}

    monkeypatch.setattr(client, 'call', fake_call)
    result = client.wait_for_execution('http://x', 'key', 'wf', correlation_id='cid-123', timeout=60)
    assert result['id'] == '7'
    assert polls['n'] == 3


def test_wait_for_execution_skips_non_matching_correlation(monkeypatch):
    _fake_clock(monkeypatch)

    def fake_call(base_url, api_key, method, path, **kw):
        if path == '/executions':
            return {
                'data': [
                    {'id': 'other', 'status': 'success', 'startedAt': '2026-06-10T00:00:02Z'},
                    {'id': 'mine', 'status': 'success', 'startedAt': '2026-06-10T00:00:01Z'},
                ]
            }
        if path == '/executions/other':
            return {'id': 'other', 'status': 'success', 'data': {'echo': 'someone-else'}}
        return {'id': 'mine', 'status': 'success', 'data': {'echo': 'cid-123'}}

    monkeypatch.setattr(client, 'call', fake_call)
    result = client.wait_for_execution('http://x', 'key', 'wf', correlation_id='cid-123', timeout=60)
    assert result['id'] == 'mine'


def test_wait_for_execution_raises_on_failed_run(monkeypatch):
    _fake_clock(monkeypatch)

    def fake_call(base_url, api_key, method, path, **kw):
        if path == '/executions':
            return {'data': [{'id': '9', 'status': 'error', 'startedAt': '2026-06-10T00:00:01Z'}]}
        return {'id': '9', 'status': 'error', 'data': {'echo': 'cid-123'}}

    monkeypatch.setattr(client, 'call', fake_call)
    with pytest.raises(ValueError, match='finished with status "error"'):
        client.wait_for_execution('http://x', 'key', 'wf', correlation_id='cid-123', timeout=60)


def test_wait_for_execution_times_out(monkeypatch):
    _fake_clock(monkeypatch, step=5.0)
    monkeypatch.setattr(client, 'call', lambda *a, **kw: {'data': []})
    with pytest.raises(ValueError, match='Timed out'):
        client.wait_for_execution('http://x', 'key', 'wf', timeout=10)


def test_wait_for_execution_ignores_runs_started_before(monkeypatch):
    _fake_clock(monkeypatch, step=5.0)

    def fake_call(base_url, api_key, method, path, **kw):
        if path == '/executions':
            return {'data': [{'id': 'old', 'status': 'success', 'startedAt': '2026-06-09T00:00:00Z'}]}
        raise AssertionError('stale execution must not be fetched')

    monkeypatch.setattr(client, 'call', fake_call)
    with pytest.raises(ValueError, match='Timed out'):
        client.wait_for_execution('http://x', 'key', 'wf', started_after='2026-06-10T00:00:00Z', timeout=10)


def test_wait_for_execution_skips_stale_run_across_iso_formats(monkeypatch):
    # started_after is rendered with a +00:00 offset (our own marker) while n8n
    # renders startedAt with a trailing Z. A lexicographic compare keeps this stale
    # run ('Z' > '.'), so this guards the datetime-based comparison: the run started
    # at 00:00:01.0, before our 00:00:01.5 trigger, and must be ignored.
    _fake_clock(monkeypatch, step=5.0)

    def fake_call(base_url, api_key, method, path, **kw):
        if path == '/executions':
            return {'data': [{'id': 'stale', 'status': 'success', 'startedAt': '2026-06-10T00:00:01Z'}]}
        raise AssertionError('a run started before started_after must not be fetched')

    monkeypatch.setattr(client, 'call', fake_call)
    with pytest.raises(ValueError, match='Timed out'):
        client.wait_for_execution('http://x', 'key', 'wf', started_after='2026-06-10T00:00:01.500000+00:00', timeout=10)


# ---------------------------------------------------------------------------
# IInstance: async branch of _run_webhook
# ---------------------------------------------------------------------------


class _FakeGlobal:
    base_url = 'http://localhost:5678'
    api_key = 'key'
    default_workflow = 'enrich'
    mode = 'async'
    payload_mode = 'simple'
    sync_timeout = 30
    async_timeout = 30
    verify_tls = True
    read_only = True
    webhook_auth = None


def _make_instance(**overrides):
    inst = instance_mod.IInstance()
    g = _FakeGlobal()
    for key, value in overrides.items():
        setattr(g, key, value)
    inst.IGlobal = g
    inst._preflight_done = True  # skip the network preflight in unit tests
    return inst


def test_async_requires_api_key():
    inst = _make_instance(api_key='')
    with pytest.raises(ValueError, match='API key'):
        inst._run_webhook('enrich', {}, test_mode=False)


def test_async_sync_short_circuit_when_data_returned(monkeypatch):
    inst = _make_instance()
    monkeypatch.setattr(instance_mod.n8n_client, 'trigger_webhook', lambda *a, **kw: {'value': 42})

    def must_not_poll(*a, **kw):
        raise AssertionError('should not poll when the webhook returned data')

    monkeypatch.setattr(instance_mod.n8n_client, 'find_workflow_id_by_path', must_not_poll)
    result = inst._run_webhook('enrich', {}, test_mode=False)
    assert result == {'success': True, 'started': True, 'result': {'value': 42}}


# ---------------------------------------------------------------------------
# IInstance: tool-face result normalization (advertised result schema)
# ---------------------------------------------------------------------------


def test_jsonsafe_tool_result_coerces_scalars_and_binary():
    norm = instance_mod.IInstance._jsonsafe_tool_result
    # JSON scalars aren't in the advertised object/array/string/null schema.
    assert norm(True) == 'true'
    assert norm(42) == '42'
    assert norm(3.5) == '3.5'
    # Binary carries raw bytes (not JSON-serialisable) -> safe descriptor.
    assert norm({'__rr_binary__': True, 'mime': 'image/png', 'data': b'\x89PNG'}) == {
        'binary': True,
        'mime': 'image/png',
        'bytes': 4,
    }
    # Objects / arrays / strings / None pass through untouched.
    assert norm({'a': 1}) == {'a': 1}
    assert norm(['x']) == ['x']
    assert norm('hi') == 'hi'
    assert norm(None) is None


def test_trigger_workflow_normalizes_result_to_schema(monkeypatch):
    inst = _make_instance(mode='sync')

    # A bare scalar webhook response is stringified so it fits the result schema.
    monkeypatch.setattr(instance_mod.n8n_client, 'trigger_webhook', lambda *a, **kw: 42)
    out = inst.trigger_workflow({'workflow': 'enrich'})
    assert out['success'] is True and out['result'] == '42'

    # A binary webhook response is reduced to a JSON-safe descriptor (no raw bytes).
    monkeypatch.setattr(
        instance_mod.n8n_client,
        'trigger_webhook',
        lambda *a, **kw: {'__rr_binary__': True, 'mime': 'image/png', 'data': b'\x89PNG'},
    )
    out = inst.trigger_workflow({'workflow': 'enrich'})
    assert out['result'] == {'binary': True, 'mime': 'image/png', 'bytes': 4}


def test_async_injects_correlation_id_and_polls(monkeypatch):
    inst = _make_instance()
    seen = {}

    def fake_trigger(base_url, path, payload, **kw):
        seen['payload'] = payload
        return {'message': 'Workflow was started'}

    def fake_wait(base_url, api_key, workflow_id, *, correlation_id, **kw):
        seen['workflow_id'] = workflow_id
        seen['wait_correlation'] = correlation_id
        return {'id': '5', 'status': 'success', 'data': {'out': 1}}

    monkeypatch.setattr(instance_mod.n8n_client, 'trigger_webhook', fake_trigger)
    monkeypatch.setattr(instance_mod.n8n_client, 'find_workflow_id_by_path', lambda *a, **kw: 'wf-9')
    monkeypatch.setattr(instance_mod.n8n_client, 'wait_for_execution', fake_wait)

    result = inst._run_webhook('enrich', {'data': 'x'}, test_mode=False)
    cid = seen['payload']['_rr_correlation_id']
    assert cid and seen['wait_correlation'] == cid
    assert seen['payload']['data'] == 'x'
    assert seen['workflow_id'] == 'wf-9'
    assert result['result']['id'] == '5'


def test_sync_mode_returns_ack_note(monkeypatch):
    inst = _make_instance(mode='sync')
    monkeypatch.setattr(
        instance_mod.n8n_client, 'trigger_webhook', lambda *a, **kw: {'message': 'Workflow was started'}
    )
    result = inst._run_webhook('enrich', {}, test_mode=False)
    assert result['result'] is None
    assert 'Respond to Webhook' in result['note']


# ---------------------------------------------------------------------------
# Phase A: bearer/JWT webhook auth
# ---------------------------------------------------------------------------


def test_apply_webhook_auth_bearer():
    headers, basic = client._apply_webhook_auth({'type': 'bearer', 'value': 'tok123'})
    assert headers == {'Authorization': 'Bearer tok123'} and basic is None


def test_apply_webhook_auth_jwt():
    headers, basic = client._apply_webhook_auth({'type': 'jwt', 'value': 'jwttok'})
    assert headers == {'Authorization': 'Bearer jwttok'} and basic is None


# ---------------------------------------------------------------------------
# Phase A: retry/backoff on idempotent GETs
# ---------------------------------------------------------------------------


def test_retry_delay_honors_retry_after():
    class R:
        headers = {'Retry-After': '3'}

    assert client._retry_delay(R(), 1) == 3.0


def test_retry_delay_backs_off_and_caps():
    class R:
        headers = {}

    assert client._retry_delay(R(), 2) == 4.0
    assert client._retry_delay(R(), 10) == client._MAX_BACKOFF


class _FakeResp:
    def __init__(self, status, payload=None):
        self.status_code = status
        self.ok = 200 <= status < 300
        self.reason = 'reason'
        self.headers = {}
        self.text = ''
        self._payload = payload if payload is not None else {}

    def json(self):
        return self._payload


def test_call_retries_transient_get_then_succeeds(monkeypatch):
    seq = [_FakeResp(503), _FakeResp(200, {'data': [1]})]
    calls = {'n': 0}

    def fake_request(method, url, **kw):
        r = seq[calls['n']]
        calls['n'] += 1
        return r

    monkeypatch.setattr(client.requests, 'request', fake_request)
    monkeypatch.setattr(client.time, 'sleep', lambda *a, **kw: None)
    out = client.call('http://x', 'k', 'GET', '/workflows')
    assert out == {'data': [1]} and calls['n'] == 2


def test_call_does_not_retry_post(monkeypatch):
    calls = {'n': 0}

    def fake_request(method, url, **kw):
        calls['n'] += 1
        return _FakeResp(503, {'message': 'boom'})

    monkeypatch.setattr(client.requests, 'request', fake_request)
    monkeypatch.setattr(client.time, 'sleep', lambda *a, **kw: None)
    with pytest.raises(ValueError):
        client.call('http://x', 'k', 'POST', '/workflows/1/activate')
    assert calls['n'] == 1  # POST must not be replayed


# ---------------------------------------------------------------------------
# Phase A: workflow-id resolution paginates via nextCursor
# ---------------------------------------------------------------------------


def test_find_workflow_id_paginates(monkeypatch):
    pages = [
        {
            'data': [{'id': 'a', 'nodes': [{'type': 'n8n-nodes-base.webhook', 'parameters': {'path': 'other'}}]}],
            'nextCursor': 'c2',
        },
        {
            'data': [{'id': 'b', 'nodes': [{'type': 'n8n-nodes-base.webhook', 'parameters': {'path': 'enrich'}}]}],
            'nextCursor': None,
        },
    ]
    calls = {'n': 0}

    def fake_call(base, key, method, path, **kw):
        i = calls['n']
        calls['n'] += 1
        return pages[i]

    monkeypatch.setattr(client, 'call', fake_call)
    assert client.find_workflow_id_by_path('http://x', 'k', 'enrich') == 'b'
    assert calls['n'] == 2  # had to page to the 2nd page


def test_wait_for_execution_timeout_hints_correlation(monkeypatch):
    _fake_clock(monkeypatch, step=5.0)
    monkeypatch.setattr(client, 'call', lambda *a, **kw: {'data': []})
    with pytest.raises(ValueError, match='_rr_correlation_id'):
        client.wait_for_execution('http://x', 'k', 'wf', correlation_id='cid', timeout=10)


# ---------------------------------------------------------------------------
# Phase B: structured vs simple payload (pipeline face)
# ---------------------------------------------------------------------------


class _FakeDoc:
    def __init__(self, content, metadata):
        self.page_content = content
        self.metadata = metadata


def test_build_payload_simple_flattens():
    inst = _make_instance(payload_mode='simple')
    inst._text_parts = ['hello ']
    inst._documents = [{'content': 'doc1', 'metadata': {}}]
    assert inst._build_payload() == {'data': 'hello doc1'}


def test_build_payload_structured_preserves_docs():
    inst = _make_instance(payload_mode='structured')
    inst._text_parts = ['q']
    inst._documents = [{'content': 'd', 'metadata': {'src': 'a.txt'}}]
    assert inst._build_payload() == {'text': 'q', 'documents': [{'content': 'd', 'metadata': {'src': 'a.txt'}}]}


def test_writedocuments_captures_content_and_metadata():
    inst = _make_instance(payload_mode='structured')
    inst._text_parts = []
    inst._documents = []
    inst.writeDocuments([_FakeDoc('body', {'src': 'a.txt', 'page': 2})])
    assert inst._documents == [{'content': 'body', 'metadata': {'src': 'a.txt', 'page': 2}}]


def test_doc_metadata_coerces_object_and_drops_private():
    class _Meta:
        def __init__(self):
            self.src = 'a'
            self._hidden = 'x'

    class _D:
        page_content = 'x'
        metadata = _Meta()

    assert instance_mod._doc_metadata(_D()) == {'src': 'a'}


def test_doc_metadata_handles_none_and_nonserializable():
    class _D1:
        metadata = None

    assert instance_mod._doc_metadata(_D1()) == {}

    class _D2:
        metadata = {'when': object()}  # non-JSON value survives via default=str

    out = instance_mod._doc_metadata(_D2())
    assert isinstance(out, dict) and 'when' in out


# ---------------------------------------------------------------------------
# Phase C: files & binary (AVI lanes, multipart, binary response)
# ---------------------------------------------------------------------------

A = instance_mod.AVI_ACTION


class _FakeInstance:
    def __init__(self, listeners):
        self._listeners = set(listeners)
        self.calls = []

    def hasListener(self, lane):
        return lane in self._listeners

    def writeText(self, t):
        self.calls.append(('text', t))

    def writeImage(self, *a):
        self.calls.append(('image',) + a)

    def writeAudio(self, *a):
        self.calls.append(('audio',) + a)

    def writeVideo(self, *a):
        self.calls.append(('video',) + a)


def _bin_inst(**over):
    inst = _make_instance(**over)
    inst._text_parts = []
    inst._documents = []
    inst._binary = []
    inst._avi_buffers = {}
    return inst


def test_avi_reassembles_image_chunks():
    inst = _bin_inst()
    inst.writeImage(A.BEGIN, 'image/png')
    inst.writeImage(A.WRITE, 'image/png', b'ab')
    inst.writeImage(A.WRITE, 'image/png', b'cd')
    inst.writeImage(A.END, 'image/png')
    assert inst._binary == [{'kind': 'image', 'mime': 'image/png', 'data': b'abcd'}]


def test_avi_size_guard(monkeypatch):
    monkeypatch.setattr(instance_mod, '_MAX_BINARY_BYTES', 4)
    inst = _bin_inst()
    inst.writeImage(A.BEGIN, 'image/png')
    with pytest.raises(ValueError, match='exceeds'):
        inst.writeImage(A.WRITE, 'image/png', b'12345')


def test_build_multipart_fields_and_files():
    inst = _bin_inst()
    inst._text_parts = ['hi']
    inst._documents = [{'content': 'd', 'metadata': {}}]
    inst._binary = [{'kind': 'image', 'mime': 'image/png', 'data': b'PNG'}]
    fields, files = inst._build_multipart()
    assert fields['text'] == 'hi'
    assert json.loads(fields['documents'])[0]['content'] == 'd'
    name, data, mime = files['image_0']
    assert name == 'image_0.png' and data == b'PNG' and mime == 'image/png'


def test_parse_response_detects_binary():
    class _R:
        headers = {'Content-Type': 'image/png'}
        content = b'\x89PNG'

        def json(self):
            raise ValueError('not json')

    assert client.parse_response(_R()) == {'__rr_binary__': True, 'mime': 'image/png', 'data': b'\x89PNG'}


def test_parse_response_json_and_text():
    class _RJ:
        headers = {'Content-Type': 'application/json'}

        def json(self):
            return {'a': 1}

    assert client.parse_response(_RJ()) == {'a': 1}

    class _RT:
        headers = {'Content-Type': 'text/plain'}
        text = 'hello'

        def json(self):
            raise ValueError('not json')

    assert client.parse_response(_RT()) == 'hello'


def test_emit_binary_to_image_lane():
    inst = _bin_inst()
    inst.instance = _FakeInstance({'image'})
    inst._emit_binary('image/png', b'XYZ')
    kinds = [c[0] for c in inst.instance.calls]
    assert kinds == ['image', 'image', 'image']  # BEGIN, WRITE, END
    write_call = [c for c in inst.instance.calls if len(c) == 4][0]
    assert write_call[3] == b'XYZ'


def test_emit_binary_falls_back_to_text_when_no_binary_lane():
    inst = _bin_inst()
    inst.instance = _FakeInstance({'text'})
    inst._emit_binary('image/png', b'1234')
    assert inst.instance.calls == [('text', '[binary image/png, 4 bytes]')]


# ---------------------------------------------------------------------------
# Phase E: execution deep-link
# ---------------------------------------------------------------------------


def test_clean_execution_adds_deeplink():
    out = client.clean_execution(
        {'id': '7', 'workflowId': 'wf9', 'status': 'success'}, base_url='http://localhost:5678'
    )
    assert out['url'] == 'http://localhost:5678/workflow/wf9/executions/7'


def test_clean_execution_no_url_without_base_or_ids():
    assert 'url' not in client.clean_execution({'id': '7', 'workflowId': 'wf9'})
    assert 'url' not in client.clean_execution({'id': '7'}, base_url='http://x')
