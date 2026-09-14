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

"""Unit tests for tool_tenki's session lifecycle and recovery (no network, no real keys)."""

from __future__ import annotations

import importlib
import sys
import threading
import time
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

# ---------------------------------------------------------------------------
# Bootstrap: when run under a bare interpreter that lacks the engine runtime
# (rocketlib, ai.common, the tenki SDK), inject lightweight stubs ONLY for
# modules that are not already present, import the module under test, then
# REMOVE the stubs we added so they never leak into the shared pytest session
# (see test_tool_tavily.py for the full rationale).
# ---------------------------------------------------------------------------

_NODES_SRC = Path(__file__).resolve().parents[1] / 'src'
if str(_NODES_SRC) not in sys.path:
    sys.path.insert(0, str(_NODES_SRC))

# Placeholder only. The tk_ prefix matters: the real SDK rejects any other key
# locally, before a request is made. Every SDK entry point is faked below, so it
# is never sent anywhere.
_KEY = 'tk_mock-tenki-placeholder-for-tests'


class _StubSandboxError(Exception):
    """Real exception classes, so IGlobal's except clauses catch them under the stub."""


class _StubSessionNotFoundError(_StubSandboxError):
    """Mirror of the SDK hierarchy: every Tenki error subclasses SandboxError directly."""


class _StubSessionTerminatedError(_StubSandboxError):
    def __init__(self, *args, termination_cause=None):
        super().__init__(*args)
        self.termination_cause = termination_cause


class _StubInvalidStateError(_StubSandboxError):
    pass


class _StubWaitReadyFailedError(_StubSandboxError):
    def __init__(self, message, sandbox=None):
        super().__init__(message)
        self.sandbox = sandbox


class _StubTemplateRuntimeFailedError(_StubSandboxError):
    def __init__(self, message, sandbox=None):
        super().__init__(message)
        self.sandbox = sandbox
        self.reason = message


def _build_import_stubs():
    """Return {module_name: stub} for the deps needed only to import the module."""
    rocketlib = MagicMock()
    rocketlib.IInstanceBase = object
    rocketlib.IGlobalBase = object
    rocketlib.tool_function = lambda **kwargs: lambda f: f
    rocketlib.debug = lambda *a, **kw: None
    rocketlib.error = lambda *a, **kw: None
    rocketlib.warning = lambda *a, **kw: None
    rocketlib.OPEN_MODE = MagicMock()

    depends = MagicMock()
    depends.depends = lambda *a, **kw: None

    tenki = MagicMock()
    tenki.Client = MagicMock()
    tenki.Sandbox = MagicMock()
    tenki.SandboxError = _StubSandboxError
    tenki.SessionNotFoundError = _StubSessionNotFoundError
    tenki.SessionTerminatedError = _StubSessionTerminatedError
    tenki.InvalidStateError = _StubInvalidStateError
    tenki.WaitReadyFailedError = _StubWaitReadyFailedError
    tenki.TemplateRuntimeFailedError = _StubTemplateRuntimeFailedError

    return {
        'rocketlib': rocketlib,
        'depends': depends,
        'ai': MagicMock(),
        'ai.common': MagicMock(),
        'ai.common.config': MagicMock(),
        'tenki': tenki,
    }


_added_stubs = []
for _name, _stub in _build_import_stubs().items():
    if _name not in sys.modules:
        sys.modules[_name] = _stub
        _added_stubs.append(_name)

mod = importlib.import_module('nodes.tool_tenki.IGlobal')

for _name in _added_stubs:
    sys.modules.pop(_name, None)


# ---------------------------------------------------------------------------
# Fakes for the Tenki SDK boundary (the network)
# ---------------------------------------------------------------------------


class _FakeSession:
    """Stand-in for tenki.Sandbox, with the SDK's semantics for the lifecycle calls.

    ``refresh`` returns the session's info record and ``close_if_open`` skips a
    session that is already terminating or terminated, as the real handle does.
    """

    def __init__(self, session_id, *, state='RUNNING', refresh_error=None, resume_delay=0.0, close_error=None):
        self.id = session_id
        self.state = state
        self._refresh_error = refresh_error
        self._resume_delay = resume_delay
        self._close_error = close_error
        self.calls = []

    def refresh(self):
        self.calls.append('refresh')
        if self._refresh_error is not None:
            raise self._refresh_error
        return SimpleNamespace(id=self.id, state=self.state)

    def resume(self):
        self.calls.append('resume')
        time.sleep(self._resume_delay)
        self.state = 'RUNNING'

    def wait_ready(self, timeout=180):
        self.calls.append('wait_ready')

    def close(self):
        self.calls.append('close')
        if self._close_error is not None:
            raise self._close_error
        self.state = 'TERMINATED'

    def close_if_open(self):
        if self.state not in ('TERMINATING', 'TERMINATED'):
            self.close()


class _FakeClient:
    """Stand-in for tenki.Client: hands out the given sessions in order and records calls."""

    def __init__(self, *sessions, create_error=None, create_delay=0.0):
        self._sessions = list(sessions)
        self._create_error = create_error
        self._create_delay = create_delay
        self.create_started = threading.Event()
        self.create_calls = []
        self.fetched = {}
        self.closed = False

    def create(self, **kwargs):
        self.create_calls.append(kwargs)
        self.create_started.set()
        time.sleep(self._create_delay)
        if self._create_error is not None:
            raise self._create_error
        return self._sessions.pop(0)

    def get(self, session_id):
        session = self.fetched[session_id] = _FakeSession(session_id)
        return session

    def close(self):
        self.closed = True


@pytest.fixture
def logs(monkeypatch):
    """Capture IGlobal's warnings and silence its debug output."""
    captured = []
    monkeypatch.setattr(mod, 'warning', lambda message, *a, **kw: captured.append(str(message)), raising=False)
    monkeypatch.setattr(mod, 'debug', lambda *a, **kw: None, raising=False)
    return captured


def _make_global(monkeypatch, cfg, client=None):
    """Return an IGlobal wired to an in-memory config and client, plus the Client(...) kwargs seen."""
    constructed = []
    fake_client = client if client is not None else _FakeClient()

    def _client(**kwargs):
        constructed.append(kwargs)
        return fake_client

    monkeypatch.setattr(mod, 'Client', _client, raising=False)
    config = SimpleNamespace(getNodeConfig=lambda logical_type, conn_config: dict(cfg))
    monkeypatch.setattr(mod, 'Config', config, raising=False)
    glb = mod.IGlobal()
    glb.IEndpoint = SimpleNamespace(endpoint=SimpleNamespace(openMode=object()))
    glb.glb = SimpleNamespace(logicalType='tool_tenki', connConfig={})
    return glb, constructed


def _started(monkeypatch, *sessions, cfg=None, **client_kwargs):
    """Return an IGlobal after beginGlobal, whose client hands out ``sessions`` in order."""
    client = _FakeClient(*sessions, **client_kwargs)
    glb, _ = _make_global(monkeypatch, {'apikey': _KEY, **(cfg or {})}, client)
    glb.beginGlobal()
    return glb, client


def _raise(error):
    raise error


def _run_in_threads(count, target):
    start = threading.Barrier(count)

    def runner():
        start.wait()
        target()

    threads = [threading.Thread(target=runner) for _ in range(count)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()


# ---------------------------------------------------------------------------
# beginGlobal / validateConfig: config handling
# ---------------------------------------------------------------------------


@pytest.mark.parametrize('cfg', [{}, {'apikey': ''}, {'apikey': '   '}, {'apikey': None}])
def test_missing_apikey_stops_before_a_client_exists(monkeypatch, logs, cfg):
    # Given an empty token the SDK reads TENKI_AUTH_TOKEN / TENKI_API_KEY from the host
    # instead, so without this check a host variable would pick the billed workspace.
    glb, constructed = _make_global(monkeypatch, cfg)
    with pytest.raises(Exception, match='apikey is required'):
        glb.beginGlobal()
    assert constructed == []


def test_client_gets_the_stripped_key_and_the_public_endpoint_explicitly(monkeypatch, logs):
    # An empty endpoint would otherwise be resolved from TENKI_API_ENDPOINT / TENKI_API_URL.
    glb, constructed = _make_global(monkeypatch, {'apikey': f'  {_KEY}  ', 'base_url': ''})
    glb.beginGlobal()
    assert constructed == [{'auth_token': _KEY, 'base_url': 'https://api.tenki.cloud'}]


def test_configured_endpoint_is_used_as_given(monkeypatch, logs):
    glb, constructed = _make_global(monkeypatch, {'apikey': _KEY, 'base_url': ' https://sandbox.example.test '})
    glb.beginGlobal()
    assert constructed[0]['base_url'] == 'https://sandbox.example.test'


def test_config_mode_tolerates_a_missing_key(monkeypatch, logs):
    # The editor opens the node before a key is typed; that must not raise.
    glb, constructed = _make_global(monkeypatch, {})
    glb.IEndpoint.endpoint.openMode = mod.OPEN_MODE.CONFIG
    glb.beginGlobal()
    assert constructed == []


@pytest.mark.parametrize(
    ('field', 'configured', 'expected'),
    [
        ('cpu_cores', 0, 1),
        ('cpu_cores', 64, 16),
        ('memory_mb', 128, 512),
        ('memory_mb', 131072, 65536),
        ('memory_mb', 4097, 4096),  # Tenki rejects odd sizes
        ('disk_size_gb', 1, 5),  # the SDK rejects anything under 5 before sending
        ('disk_size_gb', 500, 100),
        ('idle_timeout_minutes', 0, 1),
        ('idle_timeout_minutes', 1000, 120),
        ('max_duration_minutes', 0, 1),
        ('max_duration_minutes', 100000, 1440),
        ('exec_timeout_secs', 0, 1),
        ('exec_timeout_secs', 99999, 1200),
        ('max_output_chars', 10, 1000),
        ('max_output_chars', 10**9, 1000000),
    ],
)
def test_integer_config_is_clamped_to_the_accepted_range(monkeypatch, logs, field, configured, expected):
    glb, _ = _make_global(monkeypatch, {'apikey': _KEY, field: configured})
    glb.beginGlobal()
    assert getattr(glb, field) == expected


def test_unset_or_unparseable_integers_fall_back_to_defaults(monkeypatch, logs):
    glb, _ = _make_global(monkeypatch, {'apikey': _KEY, 'cpu_cores': 'four', 'memory_mb': None})
    glb.beginGlobal()
    settings = (
        glb.cpu_cores,
        glb.memory_mb,
        glb.disk_size_gb,
        glb.idle_timeout_minutes,
        glb.max_duration_minutes,
        glb.exec_timeout_secs,
        glb.max_output_chars,
    )
    assert settings == (2, 4096, 5, 5, 60, 120, 50000)


@pytest.mark.parametrize(
    ('cfg', 'warns'),
    [
        ({}, True),
        ({'apikey': 'mock-tenki-placeholder-for-tests'}, True),  # no tk_ prefix: the SDK would reject it
        ({'apikey': _KEY}, False),
    ],
)
def test_validate_config_warns_about_a_missing_or_non_tenki_key(monkeypatch, logs, cfg, warns):
    glb, _ = _make_global(monkeypatch, cfg)
    glb.validateConfig()
    assert bool(logs) is warns


# ---------------------------------------------------------------------------
# get_session: lazy creation
# ---------------------------------------------------------------------------


def test_session_is_created_on_first_use_and_then_reused(monkeypatch, logs):
    session = _FakeSession('sb-1')
    glb, client = _started(monkeypatch, session)
    assert client.create_calls == []  # beginGlobal never provisions: sessions bill
    assert glb.get_session() is session
    assert glb.get_session() is session
    assert len(client.create_calls) == 1


def test_create_sends_sizing_a_lifetime_cap_in_seconds_and_no_inbound(monkeypatch, logs):
    cfg = {
        'cpu_cores': 4,
        'memory_mb': 8192,
        'disk_size_gb': 20,
        'idle_timeout_minutes': 10,
        'max_duration_minutes': 90,
    }
    glb, client = _started(monkeypatch, _FakeSession('sb-1'), cfg=cfg)
    glb.get_session()
    assert client.create_calls == [
        {
            'cpu_cores': 4,
            'memory_mb': 8192,
            'disk_size_gb': 20,
            'idle_timeout_minutes': 10,
            'max_duration': 5400,
            'allow_inbound': False,
        }
    ]


def test_image_is_sent_when_configured(monkeypatch, logs):
    glb, client = _started(monkeypatch, _FakeSession('sb-1'), cfg={'image': ' myworkspace/node-env '})
    glb.get_session()
    assert client.create_calls[0]['image'] == 'myworkspace/node-env'


def test_parallel_first_calls_create_exactly_one_session(monkeypatch, logs):
    # deepagent fans tool calls out with asyncio.gather; unsynchronized, each call would
    # see no session and create one, and all but one would be orphaned while billing.
    glb, client = _started(monkeypatch, *[_FakeSession(f'sb-{i}') for i in range(8)], create_delay=0.05)
    sessions = []
    _run_in_threads(8, lambda: sessions.append(glb.get_session()))
    assert len(client.create_calls) == 1
    assert [session.id for session in sessions] == ['sb-0'] * 8


# ---------------------------------------------------------------------------
# Failed create: a readiness failure can leave a billing sandbox behind
# ---------------------------------------------------------------------------


def test_readiness_timeout_closes_the_sandbox_it_carries_and_reraises(monkeypatch, logs):
    left_running = _FakeSession('sb-orphan')
    error = mod.WaitReadyFailedError('sandbox sb-orphan created but not ready within wait budget', left_running)
    glb, _ = _started(monkeypatch, create_error=error)
    with pytest.raises(mod.WaitReadyFailedError):
        glb.get_session()
    assert left_running.calls == ['close']
    assert glb.session is None


def test_template_failure_raised_by_create_closes_the_session_by_id(monkeypatch, logs):
    # Raised by the create call itself, this error carries the session's info record,
    # which has no close(), so the live handle has to be fetched first.
    info = SimpleNamespace(id='sb-orphan', state='RUNNING')
    error = mod.TemplateRuntimeFailedError('template runtime failed', info)
    glb, client = _started(monkeypatch, create_error=error)
    with pytest.raises(mod.TemplateRuntimeFailedError):
        glb.get_session()
    assert client.fetched['sb-orphan'].calls == ['close']


@pytest.mark.parametrize('carried', [None, SimpleNamespace(id='sb-orphan', state='TERMINATED')])
def test_template_failure_with_nothing_left_running_closes_nothing(monkeypatch, logs, carried):
    error = mod.TemplateRuntimeFailedError('template runtime failed', carried)
    glb, client = _started(monkeypatch, create_error=error)
    with pytest.raises(mod.TemplateRuntimeFailedError):
        glb.get_session()
    assert client.fetched == {}


def test_failed_cleanup_is_logged_and_the_create_error_still_surfaces(monkeypatch, logs):
    unclosable = _FakeSession('sb-orphan', close_error=RuntimeError('connection reset'))
    error = mod.WaitReadyFailedError('not ready within wait budget', unclosable)
    glb, _ = _started(monkeypatch, create_error=error)
    with pytest.raises(mod.WaitReadyFailedError) as raised:
        glb.get_session()
    assert raised.value is error
    assert any('connection reset' in message for message in logs)


# ---------------------------------------------------------------------------
# call_with_session: recovery follows the session's real state
# ---------------------------------------------------------------------------


def test_terminated_session_is_replaced_and_the_call_retried(monkeypatch, logs):
    dead = _FakeSession('sb-dead', state='TERMINATED')
    fresh = _FakeSession('sb-fresh')
    glb, client = _started(monkeypatch, dead, fresh)
    ran_on = []

    def call(session):
        ran_on.append(session.id)
        if session is dead:
            raise mod.SessionTerminatedError('session_terminated:guest_agent_liveness')
        return 'done'

    assert glb.call_with_session(call) == 'done'
    assert ran_on == ['sb-dead', 'sb-fresh']
    assert len(client.create_calls) == 2
    assert glb.get_session() is fresh


def test_session_the_service_no_longer_knows_is_replaced(monkeypatch, logs):
    gone = _FakeSession('sb-gone', refresh_error=mod.SessionNotFoundError('session not found'))
    fresh = _FakeSession('sb-fresh')
    glb, client = _started(monkeypatch, gone, fresh)
    result = glb.call_with_session(
        lambda session: _raise(mod.SessionNotFoundError('session not found')) if session is gone else session.id
    )
    assert result == 'sb-fresh'
    assert len(client.create_calls) == 2


def test_session_shut_down_from_inside_is_closed_before_it_is_replaced(monkeypatch, logs):
    # USER_SHUTDOWN is outside the SDK's closed states, so it is terminated explicitly
    # rather than assumed gone and left holding resources.
    off = _FakeSession('sb-off', state='USER_SHUTDOWN')
    fresh = _FakeSession('sb-fresh')
    glb, _ = _started(monkeypatch, off, fresh)
    result = glb.call_with_session(
        lambda session: _raise(mod.InvalidStateError('session is not running')) if session is off else session.id
    )
    assert result == 'sb-fresh'
    assert 'close' in off.calls


def test_paused_session_is_resumed_and_never_replaced(monkeypatch, logs):
    # A pause keeps the agent's memory and files; recreating would silently destroy its work.
    paused = _FakeSession('sb-1', state='PAUSED')
    glb, client = _started(monkeypatch, paused)
    seen_states = []

    def call(session):
        seen_states.append(session.state)
        if session.state == 'PAUSED':
            raise mod.InvalidStateError('session is paused')
        return 'done'

    assert glb.call_with_session(call) == 'done'
    assert seen_states == ['PAUSED', 'RUNNING']
    assert paused.calls.count('resume') == 1
    assert paused.calls.index('resume') < paused.calls.index('wait_ready')
    assert len(client.create_calls) == 1


@pytest.mark.parametrize(
    'make_error',
    [
        lambda: mod.InvalidStateError('git checkout failed: pathspec did not match'),
        lambda: mod.SessionNotFoundError('no such path'),
    ],
)
def test_lifecycle_error_from_a_running_session_surfaces_untouched(monkeypatch, logs, make_error):
    # The SDK maps every NOT_FOUND it cannot attribute to SessionNotFoundError and every
    # unrecognised FAILED_PRECONDITION to InvalidStateError, so a healthy session raises
    # both. Replacing it would orphan a billing session and lose the agent's work.
    running = _FakeSession('sb-1')
    glb, client = _started(monkeypatch, running, _FakeSession('sb-2'))
    error = make_error()
    with pytest.raises(type(error)) as raised:
        glb.call_with_session(lambda session: _raise(error))
    assert raised.value is error
    assert 'resume' not in running.calls
    assert 'close' not in running.calls
    assert len(client.create_calls) == 1
    assert glb.get_session() is running


def test_other_errors_propagate_without_a_state_check(monkeypatch, logs):
    running = _FakeSession('sb-1')
    glb, _ = _started(monkeypatch, running)
    with pytest.raises(ValueError):
        glb.call_with_session(lambda session: _raise(ValueError('empty command')))
    assert running.calls == []


def test_recovery_happens_once_then_the_error_surfaces(monkeypatch, logs):
    paused = _FakeSession('sb-1', state='PAUSED')
    glb, _ = _started(monkeypatch, paused)
    with pytest.raises(mod.InvalidStateError):
        glb.call_with_session(lambda session: _raise(mod.InvalidStateError('session is paused')))
    assert paused.calls.count('resume') == 1


def test_parallel_calls_on_a_paused_session_resume_it_once_and_all_succeed(monkeypatch, logs):
    # Calls that failed against the paused session must retry once it is resumed, not
    # re-check the now-running session and report their own failure as unrelated.
    paused = _FakeSession('sb-1', state='PAUSED', resume_delay=0.05)
    glb, client = _started(monkeypatch, paused)
    glb.get_session()
    results, errors = [], []

    def call(session):
        if session.state == 'PAUSED':
            raise mod.InvalidStateError('session is paused')
        return 'done'

    def tool_call():
        try:
            results.append(glb.call_with_session(call))
        except Exception as e:  # collected, so a failure in a thread is reported
            errors.append(e)

    _run_in_threads(6, tool_call)
    assert errors == []
    assert results == ['done'] * 6
    assert paused.calls.count('resume') == 1
    assert len(client.create_calls) == 1


# ---------------------------------------------------------------------------
# endGlobal: nothing else stops a session that a pause would otherwise keep
# ---------------------------------------------------------------------------


def test_end_global_closes_the_session_and_the_client(monkeypatch, logs):
    session = _FakeSession('sb-1')
    glb, client = _started(monkeypatch, session)
    glb.get_session()
    glb.endGlobal()
    assert session.calls == ['close']
    assert client.closed is True
    assert glb.session is None


def test_end_global_without_a_session_closes_only_the_client(monkeypatch, logs):
    glb, client = _started(monkeypatch)
    glb.endGlobal()
    assert client.create_calls == []
    assert client.closed is True


def test_end_global_logs_a_failed_close_and_still_forgets_the_session(monkeypatch, logs):
    session = _FakeSession('sb-1', close_error=RuntimeError('connection reset'))
    glb, client = _started(monkeypatch, session)
    glb.get_session()
    glb.endGlobal()
    assert glb.session is None
    assert client.closed is True
    assert any('connection reset' in message for message in logs)


def test_end_global_waits_for_an_in_flight_create_and_closes_that_session(monkeypatch, logs):
    session = _FakeSession('sb-1')
    glb, client = _started(monkeypatch, session, create_delay=0.1)
    creator = threading.Thread(target=glb.get_session)
    creator.start()
    assert client.create_started.wait(timeout=5)
    glb.endGlobal()
    creator.join()
    assert session.calls == ['close']
