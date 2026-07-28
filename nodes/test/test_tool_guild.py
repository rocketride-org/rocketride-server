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

"""Network-free unit tests for tool_guild.

``guild_client`` holds every assumption about Guild's wire format, including the
three still unverified against a live workspace (session id field, status wire
values, which event carries the answer). These tests pin the tolerant behaviour
those helpers are relied upon for — above all that an *unrecognised* status is
treated as still-running rather than as success, so a poll waits rather than
emitting an empty answer.

Only ``requests`` is stubbed: ``guild_client`` imports nothing from the engine,
which is the point of keeping the vendor logic in its own module.
"""

from __future__ import annotations

import importlib.util
import json
import sys
import types
from pathlib import Path

import pytest

_NODE_DIR = Path(__file__).resolve().parent.parent / 'src' / 'nodes' / 'tool_guild'
_CLIENT_PATH = _NODE_DIR / 'guild_client.py'
_SERVICES_PATH = _NODE_DIR / 'services.json'


# ---------------------------------------------------------------------------
# requests stub — records calls and replays scripted responses.
# ---------------------------------------------------------------------------


class _FakeResponse:
    def __init__(self, status_code=200, body=None, headers=None, reason='error'):
        self.status_code = status_code
        self._body = body
        self.headers = headers or {}
        self.reason = reason

    @property
    def ok(self):
        return 200 <= self.status_code < 300

    def json(self):
        if isinstance(self._body, Exception):
            raise ValueError('not json')
        return self._body


class _Codes:
    """The subset of `requests.status_codes.codes` guild_client references."""

    no_content = 204
    unauthorized = 401
    forbidden = 403
    not_found = 404
    too_many_requests = 429
    internal_server_error = 500
    bad_gateway = 502
    service_unavailable = 503
    gateway_timeout = 504


class _FakeRequests(types.ModuleType):
    """Minimal `requests` stand-in with a real exception type."""

    class RequestException(Exception):
        pass

    def __init__(self):
        super().__init__('requests')
        self.calls = []
        self.responses = []
        self.raise_with = None
        self.status_codes = types.SimpleNamespace(codes=_Codes())

    def request(self, method, url, **kwargs):
        self.calls.append({'method': method, 'url': url, **kwargs})
        if self.raise_with is not None:
            exc, self.raise_with = self.raise_with, None
            raise exc
        if self.responses:
            return self.responses.pop(0)
        return _FakeResponse(200, {})

    def reset(self):
        self.calls = []
        self.responses = []
        self.raise_with = None


def _load_client():
    """Import guild_client.py with a stubbed `requests`, then restore sys.modules.

    Install-then-pop: under the shared `builder nodes:test-full` pytest session
    `requests` is real and used by unrelated nodes, so a leaked stub would break
    them. guild_client binds the module into its own namespace at import time,
    so dropping the stub afterwards is safe.
    """
    fake = _FakeRequests()
    added = 'requests' not in sys.modules
    saved = sys.modules.get('requests')
    saved_sc = sys.modules.get('requests.status_codes')
    added_sc = 'requests.status_codes' not in sys.modules
    sys.modules['requests'] = fake
    # guild_client does `from requests.status_codes import codes`, which needs the
    # submodule importable — register it alongside the stub.
    sys.modules['requests.status_codes'] = types.SimpleNamespace(codes=_Codes())
    try:
        spec = importlib.util.spec_from_file_location('tool_guild_client_under_test', _CLIENT_PATH)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
    finally:
        if added:
            sys.modules.pop('requests', None)
        elif saved is not None:
            sys.modules['requests'] = saved
        if added_sc:
            sys.modules.pop('requests.status_codes', None)
        elif saved_sc is not None:
            sys.modules['requests.status_codes'] = saved_sc
    # The module holds a reference to the stub; hand it back for assertions.
    module._fake_requests = fake  # type: ignore[attr-defined]
    return module


gc = _load_client()


@pytest.fixture(autouse=True)
def _reset_requests():
    gc._fake_requests.reset()
    yield
    gc._fake_requests.reset()


# ---------------------------------------------------------------------------
# services.json invariants
# ---------------------------------------------------------------------------


def _services():
    return json.loads(_SERVICES_PATH.read_text(encoding='utf-8'))


def test_services_declares_a_dual_data_tool_node():
    svc = _services()
    assert svc['classType'] == ['data', 'tool']
    assert svc['prefix'] == 'guild'
    assert svc['path'] == 'nodes.tool_guild'
    # A dual node must declare lanes; a pure tool node declares none.
    assert svc['lanes'], 'dual node must declare input lanes'


def test_services_marks_both_credential_halves_secure():
    fields = _services()['fields']
    for key in ('tool_guild.apiKeyId', 'tool_guild.apiKeySecret'):
        assert fields[key].get('secure') is True, f'{key} must be secure'
        assert fields[key]['default'] == '', f'{key} must not ship a real default'


def test_services_profile_and_fields_stay_in_sync():
    svc = _services()
    profile = set(svc['preconfig']['profiles']['default']) - {'title'}
    fields = {k.split('.', 1)[1] for k in svc['fields']}
    assert profile == fields


def test_services_shape_lists_only_real_fields():
    svc = _services()
    declared = set(svc['fields'])
    for section in svc['shape']:
        for prop in section['properties']:
            if prop != 'type':
                assert prop in declared, f'{prop} in shape but not in fields'


# ---------------------------------------------------------------------------
# safe_segment — agent-supplied values must not escape the path
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    'value',
    [
        'https://evil.example.com/x',
        'a/b',
        'a\\b',
        '../admin',
        '.',
        '..',
        'has space',
        'q?x=1',
        'frag#ment',
        '',
        '   ',
    ],
)
def test_safe_segment_rejects_path_and_url_smuggling(value):
    with pytest.raises(ValueError):
        gc.safe_segment(value, 'agent')


@pytest.mark.parametrize('value', ['my-agent', 'agent_1', 'ABC123', 'sess.9f3a'])
def test_safe_segment_accepts_plain_identifiers(value):
    assert gc.safe_segment(value, 'agent') == value


def test_safe_segment_strips_surrounding_whitespace():
    assert gc.safe_segment('  my-agent  ', 'agent') == 'my-agent'


# ---------------------------------------------------------------------------
# session_status — the unverified one that matters most
# ---------------------------------------------------------------------------


@pytest.mark.parametrize('raw', ['completed', 'Completed', 'COMPLETE', 'succeeded', 'success', 'done', 'finished'])
def test_session_status_recognises_success_values(raw):
    assert gc.session_status({'status': raw}) == gc.COMPLETED


@pytest.mark.parametrize('raw', ['failed', 'error', 'errored', 'cancelled', 'canceled', 'aborted', 'timed_out'])
def test_session_status_recognises_failure_values(raw):
    assert gc.session_status({'status': raw}) == gc.FAILED


@pytest.mark.parametrize('raw', ['active', 'running', 'in_progress', 'queued', 'something_new'])
def test_unknown_status_is_running_so_a_poll_keeps_waiting(raw):
    """An unrecognised status must never read as success.

    Guild documents only UI labels, so the wire values are inferred. Treating an
    unknown value as COMPLETED would emit an empty answer as though the agent had
    replied; treating it as RUNNING costs at worst a timeout, which is loud.
    """
    assert gc.session_status({'status': raw}) == gc.RUNNING


def test_session_status_reads_alternate_field_names_and_nesting():
    assert gc.session_status({'state': 'completed'}) == gc.COMPLETED
    assert gc.session_status({'sessionStatus': 'failed'}) == gc.FAILED
    assert gc.session_status({'session': {'status': 'completed'}}) == gc.COMPLETED
    assert gc.session_status({}) == gc.RUNNING
    assert gc.session_status(None) == gc.RUNNING


# ---------------------------------------------------------------------------
# session_id_of / session_error
# ---------------------------------------------------------------------------


def test_session_id_found_across_plausible_shapes():
    assert gc.session_id_of({'id': 'abc'}) == 'abc'
    assert gc.session_id_of({'session_id': 'abc'}) == 'abc'
    assert gc.session_id_of({'sessionId': 'abc'}) == 'abc'
    assert gc.session_id_of({'session': {'id': 'nested'}}) == 'nested'
    assert gc.session_id_of({'data': {'id': 'nested'}}) == 'nested'
    assert gc.session_id_of({'id': 12345}) == '12345'
    assert gc.session_id_of({}) == ''
    assert gc.session_id_of(None) == ''


def test_session_error_prefers_a_message_and_is_bounded():
    assert gc.session_error({'error': 'boom'}) == 'boom'
    assert gc.session_error({'error': {'message': 'nested boom'}}) == 'nested boom'
    assert gc.session_error({}) == 'unknown error'
    assert len(gc.session_error({'error': 'x' * 5000})) <= 300


# ---------------------------------------------------------------------------
# extract_output — the load-bearing unknown
# ---------------------------------------------------------------------------


def test_extract_output_prefers_a_known_output_event_type():
    events = [
        {'type': 'agent_console', 'text': 'thinking...'},
        {'type': 'agent_output', 'text': 'the answer'},
    ]
    assert gc.extract_output(events) == 'the answer'


def test_extract_output_takes_the_last_match_not_the_first():
    events = [
        {'type': 'agent_output', 'text': 'first turn'},
        {'type': 'agent_output', 'text': 'final turn'},
    ]
    assert gc.extract_output(events) == 'final turn'


def test_extract_output_falls_back_to_the_last_event_with_text():
    events = [{'type': 'totally_unknown', 'text': 'still the answer'}]
    assert gc.extract_output(events) == 'still the answer'


def test_extract_output_looks_one_level_into_a_payload():
    events = [{'type': 'agent_output', 'content': {'text': 'nested answer'}}]
    assert gc.extract_output(events) == 'nested answer'


def test_extract_output_handles_an_empty_or_textless_transcript():
    assert gc.extract_output([]) == ''
    assert gc.extract_output([{'type': 'agent_output'}]) == ''


def test_extract_output_preserves_content_byte_exact():
    """User content must round-trip untouched — no trimming, no case folding."""
    payload = '  Mixed Case\n\twith whitespace  '
    assert gc.extract_output([{'type': 'agent_output', 'text': payload}]) == payload


def test_event_list_unwraps_the_common_envelopes():
    assert gc._as_event_list([{'a': 1}]) == [{'a': 1}]
    assert gc._as_event_list({'events': [{'a': 1}]}) == [{'a': 1}]
    assert gc._as_event_list({'data': [{'a': 1}]}) == [{'a': 1}]
    assert gc._as_event_list({'nope': 1}) == []
    assert gc._as_event_list(None) == []


# ---------------------------------------------------------------------------
# call() — auth, errors, retry policy
# ---------------------------------------------------------------------------


def test_call_requires_both_halves_of_the_key():
    for kid, secret in (('', 's'), ('k', ''), ('', '')):
        with pytest.raises(ValueError, match='API key is required'):
            gc.call('https://app.guild.ai', kid, secret, 'GET', '/api/sessions/x')


def test_call_uses_http_basic_with_the_key_pair():
    gc._fake_requests.responses = [_FakeResponse(200, {'ok': True})]
    gc.call('https://app.guild.ai', 'key-id', 'key-secret', 'GET', '/api/sessions/x')
    assert gc._fake_requests.calls[0]['auth'] == ('key-id', 'key-secret')


def test_call_builds_the_url_without_a_double_slash():
    gc._fake_requests.responses = [_FakeResponse(200, {})]
    gc.call('https://app.guild.ai/', 'k', 's', 'GET', '/api/sessions/x')
    assert gc._fake_requests.calls[0]['url'] == 'https://app.guild.ai/api/sessions/x'


def test_unauthorized_error_mentions_trigger_scoping():
    """401 is the failure users will hit most; the message must explain the likely cause."""
    gc._fake_requests.responses = [_FakeResponse(401, {})]
    with pytest.raises(RuntimeError, match='scoped to a specific trigger'):
        gc.call('https://app.guild.ai', 'k', 's', 'GET', '/api/sessions/x')


def test_error_messages_never_echo_the_response_body():
    """An error body can contain the prompt that was sent; it must not reach the message.

    Uses 400 rather than 5xx: a 5xx on a GET is retried, so it would not surface
    on the first response.
    """
    gc._fake_requests.responses = [_FakeResponse(400, {'prompt': 'SECRET-PROMPT-TEXT'}, reason='Bad Request')]
    with pytest.raises(RuntimeError) as excinfo:
        gc.call('https://app.guild.ai', 'k', 's', 'GET', '/api/sessions/x')
    assert 'SECRET-PROMPT-TEXT' not in str(excinfo.value)


def test_a_post_is_never_retried():
    """Replaying a POST would start a second session and bill a second automation."""
    gc._fake_requests.raise_with = gc.requests.RequestException('boom')
    with pytest.raises(RuntimeError, match='request failed'):
        gc.call('https://app.guild.ai', 'k', 's', 'POST', '/api/workspaces/o/w/sessions', body={})
    assert len(gc._fake_requests.calls) == 1


def test_a_failing_get_is_retried(monkeypatch):
    monkeypatch.setattr(gc.time, 'sleep', lambda _s: None)
    gc._fake_requests.responses = [_FakeResponse(503, {}), _FakeResponse(200, {'ok': True})]
    result = gc.call('https://app.guild.ai', 'k', 's', 'GET', '/api/sessions/x')
    assert result == {'ok': True}
    assert len(gc._fake_requests.calls) == 2


def test_a_non_json_body_becomes_an_empty_dict():
    gc._fake_requests.responses = [_FakeResponse(200, ValueError('not json'))]
    assert gc.call('https://app.guild.ai', 'k', 's', 'GET', '/api/sessions/x') == {}


# ---------------------------------------------------------------------------
# start_session / event limit
# ---------------------------------------------------------------------------


def test_start_session_posts_the_documented_body():
    gc._fake_requests.responses = [_FakeResponse(200, {'id': 'sess-1'})]
    gc.start_session('https://app.guild.ai', 'k', 's', 'acme', 'ws', 'hello there')
    call = gc._fake_requests.calls[0]
    assert call['method'] == 'POST'
    # Workspace is one path segment, owner~workspace (verified against live API).
    assert call['url'].endswith('/api/workspaces/acme~ws/sessions')
    assert call['json'] == {'session_type': 'api_trigger', 'agent_input': {'text': 'hello there'}}
    # No agent configured -> no agent key, matching the documented curl example.
    assert 'agent' not in call['json']


def test_start_session_sends_the_agent_only_when_configured():
    gc._fake_requests.responses = [_FakeResponse(200, {'id': 'sess-1'})]
    gc.start_session('https://app.guild.ai', 'k', 's', 'acme', 'ws', 'hi', agent='triage-bot')
    assert gc._fake_requests.calls[0]['json']['agent'] == 'triage-bot'


def test_start_session_passes_input_byte_exact():
    gc._fake_requests.responses = [_FakeResponse(200, {'id': 'sess-1'})]
    payload = '  Ünïcode\n\tand  spacing  '
    gc.start_session('https://app.guild.ai', 'k', 's', 'acme', 'ws', payload)
    assert gc._fake_requests.calls[0]['json']['agent_input']['text'] == payload


def test_start_session_rejects_a_smuggled_workspace():
    with pytest.raises(ValueError, match='Invalid workspace'):
        gc.start_session('https://app.guild.ai', 'k', 's', 'acme', '../../admin', 'hi')


def test_events_request_overrides_guilds_truncating_default():
    """Guild defaults to 20 events, which would silently cut a long transcript."""
    gc._fake_requests.responses = [_FakeResponse(200, {'events': []})]
    gc.get_session_events('https://app.guild.ai', 'k', 's', 'sess-1')
    assert gc._fake_requests.calls[0]['params']['limit'] == gc.DEFAULT_EVENT_LIMIT
    assert gc.DEFAULT_EVENT_LIMIT > 20


def test_event_limit_is_clamped():
    for requested, expected in ((0, gc.DEFAULT_EVENT_LIMIT), (-5, 1), (99999, gc.MAX_EVENT_LIMIT)):
        gc._fake_requests.reset()
        gc._fake_requests.responses = [_FakeResponse(200, {'events': []})]
        gc.get_session_events('https://app.guild.ai', 'k', 's', 'sess-1', limit=requested)
        assert gc._fake_requests.calls[0]['params']['limit'] == expected


# ---------------------------------------------------------------------------
# wait_for_session
# ---------------------------------------------------------------------------


def test_wait_returns_once_the_session_completes(monkeypatch):
    monkeypatch.setattr(gc.time, 'sleep', lambda _s: None)
    gc._fake_requests.responses = [
        _FakeResponse(200, {'id': 'sess-1', 'status': 'active'}),
        _FakeResponse(200, {'id': 'sess-1', 'status': 'completed'}),
    ]
    session = gc.wait_for_session('https://app.guild.ai', 'k', 's', 'sess-1', timeout=30)
    assert gc.session_status(session) == gc.COMPLETED
    assert len(gc._fake_requests.calls) == 2


def test_wait_raises_with_the_reason_when_the_session_fails(monkeypatch):
    monkeypatch.setattr(gc.time, 'sleep', lambda _s: None)
    gc._fake_requests.responses = [_FakeResponse(200, {'status': 'failed', 'error': 'agent crashed'})]
    with pytest.raises(RuntimeError, match='agent crashed'):
        gc.wait_for_session('https://app.guild.ai', 'k', 's', 'sess-1', timeout=30)


def test_timeout_message_carries_the_session_id(monkeypatch):
    """A RocketRide-side timeout does not cancel the Guild session — stay traceable."""
    monkeypatch.setattr(gc.time, 'sleep', lambda _s: None)
    clock = iter([0.0, 0.0, 100.0, 100.0, 200.0, 200.0, 300.0, 300.0])
    monkeypatch.setattr(gc.time, 'monotonic', lambda: next(clock, 9999.0))
    gc._fake_requests.responses = [_FakeResponse(200, {'status': 'active'}) for _ in range(20)]
    with pytest.raises(RuntimeError, match='sess-42'):
        gc.wait_for_session('https://app.guild.ai', 'k', 's', 'sess-42', timeout=5)


# ---------------------------------------------------------------------------
# IGlobal / IInstance: load the engine-facing modules with lightweight stubs
# (test_tool_n8n pattern) so the two files that guild_client's tests never
# touch are actually imported, their @tool_function methods registered, and
# their config/budget/emit logic exercised. Stubs are dropped after import so
# they never leak into the shared `builder nodes:test-full` session.
# ---------------------------------------------------------------------------


def _build_engine_stubs():
    from unittest.mock import MagicMock

    rl = types.ModuleType('rocketlib')
    rl.IInstanceBase = object
    rl.IGlobalBase = object
    rl.Entry = object
    rl.tool_function = lambda **kw: lambda f: setattr(f, '__tool_meta__', kw) or f
    rl.debug = rl.error = lambda *a, **k: None
    rl._warnings = []
    rl.warning = lambda *a, **k: rl._warnings.append(' '.join(str(x) for x in a))
    rl.OPEN_MODE = types.SimpleNamespace(CONFIG='config', RUN='run')
    rl.AVI_ACTION = types.SimpleNamespace(BEGIN='begin', WRITE='write', END='end')

    dep = types.ModuleType('depends')
    dep.depends = lambda *a, **k: None

    u = types.ModuleType('ai.common.utils')
    u.normalize_tool_input = lambda args, **k: args if isinstance(args, dict) else {}

    def _require_str(args, key, **k):
        val = str(args.get(key, '')).strip()
        if not val:
            raise ValueError(f'{key} is required')
        return val

    u.require_str = _require_str
    u.optional_int = lambda args, key, default=None, **k: int(args[key]) if args.get(key) is not None else default
    u.parse_bool = lambda v, d: bool(v) if v is not None else d

    def _config_int(cfg, key, default, *, min_value=None, max_value=None):
        try:
            val = int(cfg.get(key))
        except (TypeError, ValueError):
            return default
        if val <= 0:  # <= 0 means "unspecified" -> default (matches config_int)
            return default
        if min_value is not None:
            val = max(min_value, val)
        if max_value is not None:
            val = min(max_value, val)
        return val

    u.config_int = _config_int

    sch = types.ModuleType('ai.common.schema')

    class _Answer:
        def __init__(self):
            self._a = None

        def setAnswer(self, a):
            self._a = a

    class _Doc:
        def __init__(self, page_content=''):
            self.page_content = page_content

    sch.Answer = _Answer
    sch.Doc = _Doc

    cfg = types.ModuleType('ai.common.config')
    cfg.Config = MagicMock()

    ai = types.ModuleType('ai')
    ai_common = types.ModuleType('ai.common')

    req = _FakeRequests()

    return {
        'rocketlib': rl,
        'depends': dep,
        'ai': ai,
        'ai.common': ai_common,
        'ai.common.utils': u,
        'ai.common.schema': sch,
        'ai.common.config': cfg,
        'requests': req,
        'requests.status_codes': types.SimpleNamespace(codes=_Codes()),
    }, rl


def _load_engine_modules():
    _NODES_SRC = _NODE_DIR.parent.parent
    if str(_NODES_SRC) not in sys.path:
        sys.path.insert(0, str(_NODES_SRC))
    stubs, rl = _build_engine_stubs()
    added = []
    saved = {}
    for name, stub in stubs.items():
        if name in sys.modules:
            saved[name] = sys.modules[name]
        else:
            added.append(name)
        sys.modules[name] = stub
    try:
        gmod = importlib.import_module('nodes.tool_guild.IGlobal')
        imod = importlib.import_module('nodes.tool_guild.IInstance')
        importlib.reload(gmod)
        importlib.reload(imod)
    finally:
        for name in added:
            sys.modules.pop(name, None)
        for name, val in saved.items():
            sys.modules[name] = val
    return gmod, imod, rl


_gmod, _imod, _rl = _load_engine_modules()


def test_engine_modules_import_and_register_tools():
    """IGlobal/IInstance load, and exactly the three MVP tools are registered."""
    tools = sorted(n for n in dir(_imod.IInstance) if getattr(getattr(_imod.IInstance, n), '__tool_meta__', None))
    assert tools == ['get_session', 'get_session_events', 'run_agent']
    for t in tools:
        meta = getattr(getattr(_imod.IInstance, t), '__tool_meta__')
        assert meta.get('input_schema'), f'{t} needs an input_schema'
        assert meta.get('description'), f'{t} needs an agent-facing description'


def test_iglobal_defaults_match_services_profile():
    g = _gmod.IGlobal
    assert g.base_url == 'https://app.guild.ai'
    assert g.timeout == 300
    assert g.max_sessions == 10
    assert g.result_mode == 'wait'


def _make_global(**over):
    """An IGlobal instance with the budget lock initialised, bypassing beginGlobal."""
    g = _gmod.IGlobal()
    g.max_sessions = over.get('max_sessions', 10)
    import threading

    g._session_lock = threading.Lock()
    g._sessions_started = 0
    return g


def test_claim_session_slot_enforces_the_budget():
    g = _make_global(max_sessions=2)
    g.claim_session_slot()
    g.claim_session_slot()
    with pytest.raises(ValueError, match='budget exhausted'):
        g.claim_session_slot()
    assert g._sessions_started == 2  # the rejected claim did not increment


def test_claim_session_slot_no_lock_is_a_noop():
    """A config-mode instance never built the lock; claiming must not crash."""
    g = _gmod.IGlobal()
    g.claim_session_slot()  # no _session_lock attribute -> early return


class _FakeInstance:
    """Minimal stand-in for the engine's `self.instance` lane sink."""

    def __init__(self, listeners=()):
        self._listeners = set(listeners)
        self.text = None
        self.answers = None
        self.documents = None
        self.table = None

    def hasListener(self, lane):
        return lane in self._listeners

    def writeText(self, t):
        self.text = t

    def writeAnswers(self, a):
        self.answers = a._a

    def writeDocuments(self, docs):
        self.documents = [d.page_content for d in docs]

    def writeTable(self, t):
        self.table = t


def _make_instance(monkeypatch, gclient, **global_over):
    """An IInstance wired to a stubbed guild_client and a fresh budget."""
    inst = _imod.IInstance.__new__(_imod.IInstance)
    g = _make_global(**global_over)
    g.base_url = 'https://app.guild.ai'
    g.key_id = 'kid'
    g.key_secret = 'ksec'
    g.owner = 'acme'
    g.workspace = 'ws'
    g.default_agent = global_over.get('default_agent', 'hello-agent')
    g.result_mode = 'wait'
    g.timeout = 300
    g.verify_tls = True
    inst.IGlobal = g
    inst._text_parts = []
    inst._documents = []
    # Swap the module-level guild_client the instance calls into; monkeypatch
    # restores it after the test so the stub never leaks to other tests.
    monkeypatch.setattr(_imod, 'guild_client', gclient)
    return inst


class _StubClient:
    """Records calls; the ordering assertion depends on this sequence."""

    RUNNING, COMPLETED, FAILED = 'running', 'completed', 'failed'
    DEFAULT_EVENT_LIMIT = 100
    MAX_EVENT_LIMIT = 1000

    def __init__(self):
        self.calls = []

    def start_session(self, *a, **k):
        self.calls.append('start_session')
        return {'id': 'sess-xyz'}

    def session_id_of(self, s):
        return s.get('id', '')

    def wait_for_session(self, *a, **k):
        self.calls.append('wait_for_session')
        return {'status': 'completed'}

    def get_session_events(self, *a, **k):
        self.calls.append('get_session_events')
        return [{'type': 'agent_output', 'text': 'RR_MARKER ok'}]

    def extract_output(self, events):
        return events[-1]['text'] if events else ''


def test_run_agent_claims_budget_before_starting_the_session(monkeypatch):
    """The billed POST must be gated by the budget, not the other way round."""
    client = _StubClient()
    inst = _make_instance(monkeypatch, client, max_sessions=1)
    out = inst._run_agent('hello', 'hello-agent', wait=True)
    assert out['output'] == 'RR_MARKER ok'
    assert out['session_id'] == 'sess-xyz'
    assert client.calls == ['start_session', 'wait_for_session', 'get_session_events']
    # Budget is now spent; a second call must be refused BEFORE any start_session.
    client.calls = []
    with pytest.raises(ValueError, match='budget exhausted'):
        inst._run_agent('again', 'hello-agent', wait=True)
    assert client.calls == [], 'no Guild call may fire once the budget is exhausted'


def test_pipeline_closing_emits_answer_on_connected_lanes_only(monkeypatch):
    client = _StubClient()
    inst = _make_instance(monkeypatch, client)
    inst.instance = _FakeInstance(listeners=('text', 'answers'))
    inst._text_parts = ['find the ']
    inst._documents = ['overdue invoices']
    # Parts joined with a newline, each byte-exact.
    assert inst._build_input() == 'find the \noverdue invoices'
    inst.closing()
    assert inst.instance.text == 'RR_MARKER ok'
    assert inst.instance.answers == 'RR_MARKER ok'
    assert inst.instance.documents is None  # not connected -> not written
    assert client.calls[0] == 'start_session'


def test_pipeline_closing_without_input_starts_no_session(monkeypatch):
    client = _StubClient()
    inst = _make_instance(monkeypatch, client)
    inst.instance = _FakeInstance(listeners=('text',))
    inst.closing()  # no lane input accumulated
    assert client.calls == [], 'empty input must not start a billed session'


def test_pipeline_closing_requires_a_configured_agent(monkeypatch):
    client = _StubClient()
    inst = _make_instance(monkeypatch, client, default_agent='')
    inst.instance = _FakeInstance(listeners=('text',))
    inst._text_parts = ['something']
    with pytest.raises(ValueError, match='no agent configured'):
        inst.closing()


# ---------------------------------------------------------------------------
# Real-shape regression: these mirror JSON captured from a live Guild session
# (guild session create/get/events) on 2026-07-23. If Guild changes its wire
# format, these break loudly instead of the node silently timing out.
# ---------------------------------------------------------------------------

_REAL_SESSION_DONE = {
    'id': '019f9100-8c03-351a-0000-ff17deab2cba',
    'entity_type': 'EntSessionChat',
    'session_type': 'chat',
    'root_task': {'entity_type': 'EntTaskAgent', 'status': 'DONE'},
}
_REAL_SESSION_RUNNING = {'id': 'x', 'root_task': {'status': 'DISPATCHED'}}
_REAL_EVENTS_RESPONSE = {
    'items': [
        {'type': 'user_message', 'content': 'hello from rocketride RR_MARKER_7F3A9'},
        {
            'type': 'agent_notification_message',
            'content': {'is_delta': True, 'status': 'aborted', 'text': '', 'type': 'application/guild-response-stream'},
        },
        {'type': 'agent_notification_progress', 'content': {'data': 'RR_MARKER_7F3A9 ok', 'type': 'text'}},
        {'type': 'agent_notification_message', 'content': {'data': 'RR_MARKER_7F3A9 ok', 'type': 'text'}},
    ],
    'pagination': {'has_more': False, 'limit': 100, 'offset': 0, 'total_count': 4},
}


def test_real_session_id_is_top_level_id():
    assert gc.session_id_of(_REAL_SESSION_DONE) == '019f9100-8c03-351a-0000-ff17deab2cba'


def test_real_status_reads_root_task_done_as_completed():
    assert gc.session_status(_REAL_SESSION_DONE) == gc.COMPLETED


def test_real_status_reads_root_task_dispatched_as_running():
    assert gc.session_status(_REAL_SESSION_RUNNING) == gc.RUNNING


def test_real_events_response_items_are_extracted():
    assert len(gc._as_event_list(_REAL_EVENTS_RESPONSE)) == 4


def test_real_output_is_pulled_from_agent_notification_message_content_data():
    events = gc._as_event_list(_REAL_EVENTS_RESPONSE)
    # The answer sits at content.data; the empty stream-delta must be skipped.
    assert gc.extract_output(events) == 'RR_MARKER_7F3A9 ok'


def test_extract_output_never_emits_noise_as_the_answer():
    """A transcript with no agent answer must return '' — never the user echo,
    a banner, a span marker, or an intermediate progress step, all of which
    carry text but are not the answer.
    """
    # user echo only
    assert gc.extract_output([{'type': 'user_message', 'content': 'PLEASE FILE A TICKET'}]) == ''
    # noise span markers only (content 'text' is the literal runtime_start value)
    assert (
        gc.extract_output(
            [
                {'type': 'trigger_message', 'content': 'Triggering agent ...'},
                {'type': 'runtime_start', 'content': 'text'},
                {'type': 'llm_start', 'content': None},
            ]
        )
        == ''
    )
    # an intermediate progress step is not the final answer
    assert (
        gc.extract_output([{'type': 'agent_notification_progress', 'content': {'data': 'step 3 of 9', 'type': 'text'}}])
        == ''
    )


def test_extract_output_finds_an_unknown_but_non_noise_answer_type():
    """The fallback still surfaces a text-bearing event of an unfamiliar type,
    as long as it is not known noise — tolerance for shapes not yet seen.
    """
    events = [
        {'type': 'user_message', 'content': 'question'},
        {'type': 'some_future_answer_event', 'content': {'data': 'the real answer', 'type': 'text'}},
    ]
    assert gc.extract_output(events) == 'the real answer'


def test_real_api_trigger_transcript_ignores_noise_events():
    """A real api_trigger session emits many noise events around the answer
    (trigger_message, system_message, runtime_*, llm_*, an empty stream-delta).
    extract_output must land on the agent's answer and skip all of them.
    Mirrors a live 13-event api_trigger transcript captured 2026-07-23.
    """
    events = [
        {'type': 'trigger_message', 'content': 'Triggering agent ... with the following input: {...}'},
        {'type': 'system_message', 'content': 'Fetching agent package...'},
        {'type': 'runtime_start', 'content': None},
        {'type': 'runtime_done', 'content': None},
        {'type': 'runtime_start', 'content': 'text'},
        {'type': 'llm_start', 'content': None},
        {'type': 'llm_done', 'content': None},
        {
            'type': 'agent_notification_message',
            'content': {'is_delta': True, 'status': 'aborted', 'text': '', 'type': 'application/guild-response-stream'},
        },
        {'type': 'runtime_start', 'content': 'progress'},
        {'type': 'agent_notification_progress', 'content': {'data': 'RR_MARKER_7F3A9 ok', 'type': 'text'}},
        {'type': 'runtime_done', 'content': None},
        {'type': 'agent_notification_message', 'content': {'data': 'RR_MARKER_7F3A9 ok', 'type': 'text'}},
        {'type': 'runtime_done', 'content': 'text'},
    ]
    assert gc.extract_output(events) == 'RR_MARKER_7F3A9 ok'


def test_real_api_trigger_session_type_shapes():
    """The api_trigger session labels differ from chat but the load-bearing
    fields (root_task.status, top-level id) are identical — the node keys off
    those, not the entity_type / session_type labels.
    """
    session = {
        'id': '019f917c-0dd8-f9c4-0000-ffe4a69f586f',
        'entity_type': 'EntSessionTriggerApi',
        'session_type': 'api',
        'status': None,
        'root_task': {'status': 'DONE'},
    }
    assert gc.session_id_of(session) == '019f917c-0dd8-f9c4-0000-ffe4a69f586f'
    assert gc.session_status(session) == gc.COMPLETED


# ---------------------------------------------------------------------------
# get_session_events pagination — the answer is on the last page, so a
# single-page read drops it on any transcript past one page.
# ---------------------------------------------------------------------------


def _events_page(items, *, has_more, limit=100, offset=0, total=None):
    body = {'items': items, 'pagination': {'has_more': has_more, 'limit': limit, 'offset': offset}}
    if total is not None:
        body['pagination']['total_count'] = total
    return _FakeResponse(200, body)


def test_get_session_events_follows_pagination_to_the_last_page():
    p1 = [{'type': 'user_message', 'content': 'q'}, {'type': 'runtime_start', 'content': 'text'}]
    p2 = [{'type': 'agent_notification_message', 'content': {'data': 'the answer', 'type': 'text'}}]
    gc._fake_requests.responses = [
        _events_page(p1, has_more=True, offset=0),
        _events_page(p2, has_more=False, offset=2),
    ]
    events = gc.get_session_events('https://app.guild.ai', 'k', 's', 'sess-1', limit=2)
    assert len(events) == 3
    # both pages fetched, and the answer (last page) is present
    assert gc.extract_output(events) == 'the answer'
    # second request carried the advancing offset
    assert gc._fake_requests.calls[1]['params']['offset'] == 2


def test_get_session_events_single_page_makes_one_request():
    gc._fake_requests.responses = [
        _events_page([{'type': 'agent_notification_message', 'content': {'data': 'a', 'type': 'text'}}], has_more=False)
    ]
    events = gc.get_session_events('https://app.guild.ai', 'k', 's', 'sess-1')
    assert len(events) == 1
    assert len(gc._fake_requests.calls) == 1


def test_get_session_events_stops_at_max_event_limit():
    # every page says has_more; the cap must stop the loop.
    page = [{'type': 'x', 'content': str(i)} for i in range(100)]
    gc._fake_requests.responses = [_events_page(page, has_more=True, offset=i * 100) for i in range(20)]
    events = gc.get_session_events('https://app.guild.ai', 'k', 's', 'sess-1', limit=100)
    assert len(events) <= gc.MAX_EVENT_LIMIT


def test_has_more_infers_from_total_count_when_flag_absent():
    data = {'items': [], 'pagination': {'total_count': 250, 'limit': 100}}
    assert gc._has_more(data, offset=0, page_len=100) is True
    assert gc._has_more(data, offset=200, page_len=50) is False


# ---------------------------------------------------------------------------
# beginGlobal — config read, env fallbacks, clamps, CONFIG-mode early return.
# ---------------------------------------------------------------------------


def _run_begin_global(monkeypatch, cfg, *, open_mode=None):
    g = _gmod.IGlobal()
    om = _gmod.OPEN_MODE.RUN if open_mode is None else open_mode
    g.IEndpoint = types.SimpleNamespace(endpoint=types.SimpleNamespace(openMode=om))
    g.glb = types.SimpleNamespace(logicalType='tool_guild', connConfig={})
    monkeypatch.setattr(_gmod.Config, 'getNodeConfig', lambda *a, **k: cfg)
    g.beginGlobal()
    return g


def test_begin_global_reads_config(monkeypatch):
    g = _run_begin_global(
        monkeypatch,
        {
            'baseUrl': 'https://self.example.com/',
            'apiKeyId': 'kid',
            'apiKeySecret': 'ksec',
            'owner': 'acme',
            'workspace': 'ws',
            'agent': 'bot',
            'resultMode': 'wait',
        },
    )
    assert g.base_url == 'https://self.example.com'  # trailing slash stripped
    assert (g.key_id, g.key_secret, g.owner, g.workspace, g.default_agent) == ('kid', 'ksec', 'acme', 'ws', 'bot')


def test_begin_global_falls_back_to_env(monkeypatch):
    for name, val in [
        ('ROCKETRIDE_GUILD_KEY_ID', 'envid'),
        ('ROCKETRIDE_GUILD_KEY_SECRET', 'envsecret'),
        ('ROCKETRIDE_GUILD_OWNER', 'envowner'),
        ('ROCKETRIDE_GUILD_WORKSPACE', 'envws'),
        ('ROCKETRIDE_GUILD_AGENT', 'envbot'),
    ]:
        monkeypatch.setenv(name, val)
    g = _run_begin_global(monkeypatch, {})
    assert (g.key_id, g.key_secret, g.owner, g.workspace, g.default_agent) == (
        'envid',
        'envsecret',
        'envowner',
        'envws',
        'envbot',
    )


def test_begin_global_config_mode_is_an_early_return(monkeypatch):
    g = _run_begin_global(monkeypatch, {'apiKeyId': 'should-not-be-read'}, open_mode=_gmod.OPEN_MODE.CONFIG)
    assert g.key_id == ''  # class default, beginGlobal returned before reading


def test_begin_global_clamps_and_defaults_numeric(monkeypatch):
    g = _run_begin_global(monkeypatch, {'timeout': 99999, 'maxSessions': 0, 'agent': 'b'})
    assert g.timeout == 3600  # clamped to max
    assert g.max_sessions == _gmod.DEFAULT_MAX_SESSIONS  # 0 means "unspecified" -> default
    g2 = _run_begin_global(monkeypatch, {'timeout': 'abc', 'agent': 'b'})
    assert g2.timeout == _gmod.DEFAULT_TIMEOUT  # non-numeric -> default


def test_begin_global_result_mode_normalises(monkeypatch):
    assert _run_begin_global(monkeypatch, {'resultMode': 'START', 'agent': 'b'}).result_mode == 'start'
    assert _run_begin_global(monkeypatch, {'resultMode': 'garbage', 'agent': 'b'}).result_mode == 'wait'


# ---------------------------------------------------------------------------
# validateConfig — the canvas warnings a user sees on a misconfig.
# ---------------------------------------------------------------------------


def _run_validate_config(monkeypatch, cfg):
    for name in (
        'ROCKETRIDE_GUILD_KEY_ID',
        'ROCKETRIDE_GUILD_KEY_SECRET',
        'ROCKETRIDE_GUILD_OWNER',
        'ROCKETRIDE_GUILD_WORKSPACE',
        'ROCKETRIDE_GUILD_AGENT',
    ):
        monkeypatch.delenv(name, raising=False)
    _rl._warnings.clear()
    g = _gmod.IGlobal()
    g.glb = types.SimpleNamespace(logicalType='tool_guild', connConfig={})
    monkeypatch.setattr(_gmod.Config, 'getNodeConfig', lambda *a, **k: cfg)
    g.validateConfig()
    return _rl._warnings


def test_validate_config_warns_on_half_a_key(monkeypatch):
    warnings = _run_validate_config(monkeypatch, {'apiKeyId': 'x', 'owner': 'o', 'workspace': 'w', 'agent': 'a'})
    assert any('half of the API key' in w for w in warnings)


def test_validate_config_warns_on_missing_workspace_and_agent(monkeypatch):
    warnings = _run_validate_config(monkeypatch, {'apiKeyId': 'x', 'apiKeySecret': 'y'})
    text = '\n'.join(warnings)
    assert 'owner is empty' in text
    assert 'Workspace is empty' in text
    assert 'no Agent configured' in text


def test_validate_config_warns_on_start_mode(monkeypatch):
    warnings = _run_validate_config(
        monkeypatch,
        {'apiKeyId': 'x', 'apiKeySecret': 'y', 'owner': 'o', 'workspace': 'w', 'agent': 'a', 'resultMode': 'start'},
    )
    assert any('Result mode' in w and 'start' in w for w in warnings)


# ---------------------------------------------------------------------------
# Public tool functions end to end (run_agent / get_session / get_session_events).
# ---------------------------------------------------------------------------


def test_run_agent_tool_resolves_wait_from_result_mode(monkeypatch):
    client = _StubClient()
    inst = _make_instance(monkeypatch, client)  # result_mode='wait'
    out = inst.run_agent({'input': 'hi'})  # no 'wait' arg -> resolves to wait
    assert out['output'] == 'RR_MARKER ok'
    assert 'wait_for_session' in client.calls


def test_run_agent_tool_start_mode_does_not_wait(monkeypatch):
    client = _StubClient()
    inst = _make_instance(monkeypatch, client)
    inst.IGlobal.result_mode = 'start'
    out = inst.run_agent({'input': 'hi'})  # no 'wait' arg -> resolves to start
    assert out['status'] == client.RUNNING
    assert out['output'] is None
    assert 'wait_for_session' not in client.calls


def test_run_agent_tool_falls_back_to_default_agent(monkeypatch):
    captured = {}

    class _CapClient(_StubClient):
        def start_session(self, *a, **k):
            captured['agent'] = k.get('agent')
            return super().start_session(*a, **k)

    inst = _make_instance(monkeypatch, _CapClient(), default_agent='configured-bot')
    inst.run_agent({'input': 'hi'})  # no 'agent' arg
    assert captured['agent'] == 'configured-bot'


def test_get_session_tool_end_to_end(monkeypatch):
    stub = types.SimpleNamespace(
        get_session=lambda *a, **k: {'root_task': {'status': 'DONE'}},
        session_status=lambda s: 'completed',
    )
    inst = _make_instance(monkeypatch, stub)
    out = inst.get_session({'session_id': 'sess-9'})
    assert out == {'success': True, 'session_id': 'sess-9', 'status': 'completed'}


def test_get_session_events_tool_passes_bounded_limit(monkeypatch):
    captured = {}

    def _events(*a, **k):
        captured['limit'] = k.get('limit')
        return [{'type': 'agent_notification_message', 'content': {'data': 'ans', 'type': 'text'}}]

    stub = types.SimpleNamespace(
        get_session_events=_events,
        extract_output=lambda events: 'ans',
        DEFAULT_EVENT_LIMIT=100,
        MAX_EVENT_LIMIT=1000,
    )
    inst = _make_instance(monkeypatch, stub)
    out = inst.get_session_events({'session_id': 'sess-9', 'limit': 5})
    assert out['output'] == 'ans'
    assert captured['limit'] == 5
