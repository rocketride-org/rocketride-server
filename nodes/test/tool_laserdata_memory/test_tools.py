# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Unit tests for the tool_laserdata_memory node.

Pure-Python: no server, no engine, no real laser-sdk. The node module is
imported under composable stubs for ``rocketlib`` and ``ai.common.*`` so the
relative ``from .IGlobal import IGlobal`` resolves without the engine runtime.
laser-sdk itself is never imported (the node imports it lazily inside the
connect coroutine); tests exercise the SDK boundary through fake Laser/Memory
objects instead.

Covers:
* ``beginGlobal`` — CONFIG-mode skip, required connection string (+ env
  fallback), numeric clamps, boolean guards.
* the async→sync bridge — real daemon-thread loop, timeout mapping,
  not-open guard, single-flight lazy connect.
* ``endGlobal`` — connection close, loop shutdown, secret clearing.
* ``remember`` / ``recall`` / ``improve`` / ``forget`` — input validation,
  namespace resolution (config default, override gating), verbatim payload,
  limit clamping, result shaping, and error mapping to RuntimeError.
"""

from __future__ import annotations

import asyncio
import json
import sys
import threading
import time
import types
from pathlib import Path
from types import SimpleNamespace

import pytest

_NODE_DIR = Path(__file__).resolve().parent.parent.parent / 'src' / 'nodes' / 'tool_laserdata_memory'


# ---------------------------------------------------------------------------
# Import scaffolding: build FRESH stubs unconditionally. Never read the object
# already in sys.modules — the _saved_core save/restore below restores the real
# one, so a fresh stub can't leak even without the engine loaded.
# ---------------------------------------------------------------------------


def _tool_function(**_meta):
    """Stub @tool_function decorator that records metadata and returns the function."""

    def wrap(fn):
        """Attach tool metadata to the wrapped function and return it."""
        fn.__tool_meta__ = _meta
        return fn

    return wrap


def _ensure_rocketlib() -> None:
    """Install a fresh rocketlib stub so the node imports without the engine."""
    mod = types.ModuleType('rocketlib')
    mod.IInstanceBase = type('IInstanceBase', (), {})
    mod.IGlobalBase = type('IGlobalBase', (), {})
    mod.tool_function = _tool_function
    mod.OPEN_MODE = type('OPEN_MODE', (), {'CONFIG': 'config'})
    for name in ('debug', 'error', 'warning'):
        setattr(mod, name, lambda *a, **k: None)
    sys.modules['rocketlib'] = mod


def _passthrough(args, tool_name=None):
    """Identity stand-in for normalize_tool_input (returns dict args unchanged)."""
    return args if isinstance(args, dict) else {}


def _require_str(args, key, *, tool_name=''):
    """Faithful stub of ai.common.utils.require_str (same contract + wording)."""
    val = args.get(key)
    if not isinstance(val, str) or not val.strip():
        prefix = f'{tool_name}: ' if tool_name else ''
        raise ValueError(f'{prefix}"{key}" is required and must be a non-empty string')
    return val.strip()


def _optional_str(args, key, *, default=None, tool_name=''):
    """Faithful stub of ai.common.utils.optional_str."""
    if key not in args or args[key] is None:
        return default
    val = args[key]
    if not isinstance(val, str):
        prefix = f'{tool_name}: ' if tool_name else ''
        raise ValueError(f'{prefix}"{key}" must be a string')
    return val


def _int_arg(args, key, *, default, lo, hi, tool_name=''):
    """Faithful stub of ai.common.utils.int_arg (clamps; rejects bool/non-int)."""
    value = args.get(key)
    if value is None:
        value = default
    if isinstance(value, bool) or not isinstance(value, int):
        prefix = f'{tool_name}: ' if tool_name else ''
        raise ValueError(f'{prefix}"{key}" must be an integer')
    return max(lo, min(value, hi))


def _config_int(cfg, key, default, *, min_value=None, max_value=None):
    """Faithful stub of ai.common.utils.config_int (<=0/malformed -> default, then clamp)."""
    raw = cfg.get(key)
    if raw is None:
        val = default
    else:
        try:
            val = int(raw)
            if val <= 0:
                val = default
        except (TypeError, ValueError):
            val = default
    if min_value is not None:
        val = max(val, min_value)
    if max_value is not None:
        val = min(val, max_value)
    return val


def _ensure_ai_common() -> None:
    """Install fresh ``ai.common.*`` stubs so the node imports without the engine."""
    for name in ('ai', 'ai.common', 'ai.common.utils', 'ai.common.config'):
        sys.modules[name] = types.ModuleType(name)
    # Mark containers as packages so sub-imports resolve even if not pre-inserted.
    sys.modules['ai'].__path__ = []
    sys.modules['ai.common'].__path__ = []
    utils = sys.modules['ai.common.utils']
    utils.normalize_tool_input = _passthrough
    utils.require_str = _require_str
    utils.optional_str = _optional_str
    utils.int_arg = _int_arg
    utils.config_int = _config_int

    class _Config:
        """Minimal Config stub returning an empty node config."""

        @staticmethod
        def getNodeConfig(*_a, **_k):
            """Return an empty config dict."""
            return {}

    sys.modules['ai.common.config'].Config = _Config


def _ensure_pkg() -> None:
    """Register a tool_laserdata_memory package pointing at the node source directory."""
    if 'tool_laserdata_memory' not in sys.modules:
        pkg = types.ModuleType('tool_laserdata_memory')
        pkg.__path__ = [str(_NODE_DIR)]
        sys.modules['tool_laserdata_memory'] = pkg


def _ensure_nodes_core() -> None:
    """Register nodes / nodes.core packages so `from nodes.core import laserdata_tasking` resolves."""
    src = Path(__file__).resolve().parent.parent.parent / 'src' / 'nodes'
    nodes = types.ModuleType('nodes')
    nodes.__path__ = [str(src)]
    core = types.ModuleType('nodes.core')
    core.__path__ = [str(src / 'core')]
    sys.modules['nodes'] = nodes
    sys.modules['nodes.core'] = core


# Stub engine-only deps just long enough to import the node, then restore
# sys.modules so these stubs never leak to sibling tests.
_CORE_STUBS = (
    'rocketlib',
    'ai',
    'ai.common',
    'ai.common.utils',
    'ai.common.config',
    'nodes',
    'nodes.core',
    'nodes.core.laserdata_tasking',
)
_saved_core = {_name: sys.modules.get(_name) for _name in _CORE_STUBS}

_ensure_rocketlib()
_ensure_ai_common()
_ensure_pkg()
_ensure_nodes_core()

try:
    from tool_laserdata_memory import IGlobal as IGlobalMod  # noqa: E402
    from tool_laserdata_memory import IInstance as IInstanceMod  # noqa: E402
    from tool_laserdata_memory.IGlobal import IGlobal  # noqa: E402
    from tool_laserdata_memory.IInstance import IInstance, _shape_items  # noqa: E402
finally:
    for _name, _mod in _saved_core.items():
        if _mod is None:
            sys.modules.pop(_name, None)
        else:
            sys.modules[_name] = _mod


# ---------------------------------------------------------------------------
# Fakes for the laser-sdk boundary
# ---------------------------------------------------------------------------


class FakeItem:
    """Attribute-bag standing in for laser_sdk.MemoryItem."""

    def __init__(self, **kw):
        self.id = kw.get('id', '01TEST')
        self.text = kw.get('text', 'a fact')
        self.score = kw.get('score')
        self.conversation_id = kw.get('conversation_id')
        self.kind = kw.get('kind')
        self.payload = kw.get('payload')


class FakeMemory:
    """Records SDK memory calls and returns canned results."""

    def __init__(self, state, namespace):
        self.state = state
        self.namespace = namespace

    async def remember(self, payload, **kwargs):
        self.state['calls'].append(('remember', self.namespace, payload, kwargs))
        exc = self.state.get('raise')
        if exc:
            raise exc
        return self.state.get('memory_id', '01MEM')

    async def recall(self, **kwargs):
        self.state['calls'].append(('recall', self.namespace, kwargs))
        exc = self.state.get('raise')
        if exc:
            raise exc
        return self.state.get('items', [])

    async def improve(self, memory_id, weight, **kwargs):
        self.state['calls'].append(('improve', self.namespace, memory_id, weight, kwargs))
        exc = self.state.get('raise')
        if exc:
            raise exc
        return self.state.get('feedback_id', '01FB')

    async def forget(self, memory_id, **kwargs):
        self.state['calls'].append(('forget', self.namespace, memory_id, kwargs))
        exc = self.state.get('raise')
        if exc:
            raise exc
        return None


class FakeLaser:
    """Records namespace lookups and connection close."""

    def __init__(self, state):
        self.state = state

    def memory(self, namespace):
        return FakeMemory(self.state, namespace)

    def topic(self, name):
        return FakeTopic(self.state, name)

    async def send_agent(self, topic, payload, provenance):
        self.state['calls'].append(('send_agent', topic, json.loads(payload), provenance))
        rec = SimpleNamespace(json=lambda p=payload: json.loads(p))
        self.state.setdefault('topics', {}).setdefault(topic, []).append(rec)

    async def __aexit__(self, *_exc):
        self.state['closed'] = True


class FakeTopic:
    """Records ensure/publish; replay() returns a cursor over state['topics'][name]."""

    def __init__(self, state, name):
        self.state, self.name = state, name

    async def ensure(self, partitions):
        self.state.setdefault('ensured', []).append((self.name, partitions))

    def publish(self, body):
        state, name = self.state, self.name

        class _Req:
            async def send(self_inner):
                state.setdefault('topics', {}).setdefault(name, []).append(SimpleNamespace(json=lambda b=body: b))

        return _Req()

    def replay(self):
        return FakeCursor(self.state, self.name)


class FakeCursor:
    """Each poll returns records appended to the topic since the previous poll."""

    def __init__(self, state, name):
        self.state, self.name, self.pos = state, name, 0

    async def poll(self):
        hook = self.state.get('on_poll')
        if hook:
            hook(self.state, self.name)
        recs = self.state.setdefault('topics', {}).setdefault(self.name, [])
        new, self.pos = recs[self.pos :], len(recs)
        return new


class StubGlobal:
    """IGlobal stand-in for IInstance tests: drives coroutines synchronously."""

    def __init__(self, state, **overrides):
        self.state = state
        self.connection_string = 'iggy:laser@localhost:8090'
        self.namespace = 'ns-default'
        self.allow_namespace_override = True
        self.folded = True
        self.recall_limit = 10
        self.op_timeout = 30
        self.agent_id = 'intake'
        self.ensured_topics = set()
        for k, v in overrides.items():
            setattr(self, k, v)

    def run(self, coro, *, timeout=None):
        return asyncio.run(coro)

    def get_laser(self):
        return FakeLaser(self.state)


# ---------------------------------------------------------------------------
# Fixtures / helpers
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _pin_normalizer(monkeypatch):
    """Pin the input normalizer to a passthrough per test (scoped + auto-restored)."""
    monkeypatch.setattr(IInstanceMod, 'normalize_tool_input', _passthrough)


def _instance(state=None, **overrides):
    """Construct an IInstance bound to a StubGlobal; returns (instance, call state)."""
    state = state if state is not None else {'calls': []}
    inst = IInstance()
    inst.IGlobal = StubGlobal(state, **overrides)
    return inst, state


def _depends_stub():
    """Fresh no-op ``depends`` module."""
    mod = types.ModuleType('depends')
    mod.depends = lambda *_a, **_k: None
    return mod


def _real_global(monkeypatch, cfg, open_mode='run'):
    """Build a real IGlobal and run beginGlobal against a stubbed config."""
    monkeypatch.setitem(sys.modules, 'depends', _depends_stub())

    class _Config:
        @staticmethod
        def getNodeConfig(*_a, **_k):
            return dict(cfg)

    monkeypatch.setattr(IGlobalMod, 'Config', _Config)
    glb = IGlobal()
    glb.IEndpoint = SimpleNamespace(endpoint=SimpleNamespace(openMode=open_mode))
    glb.glb = SimpleNamespace(logicalType='tool_laserdata_memory', connConfig={})
    glb.beginGlobal()
    return glb


@pytest.fixture
def fake_sdk(monkeypatch):
    """Install a fake laser_sdk exposing Provenance(**kw) -> dict."""
    mod = types.ModuleType('laser_sdk')
    mod.Provenance = lambda **kw: dict(kw)
    monkeypatch.setitem(sys.modules, 'laser_sdk', mod)
    return mod


@pytest.fixture
def bridge(monkeypatch):
    """A real, begun IGlobal (live bridge loop) that is always torn down."""
    glbs = []

    def make(cfg=None, **kw):
        glb = _real_global(monkeypatch, cfg or {'connection_string': 'iggy:laser@localhost:8090'}, **kw)
        glbs.append(glb)
        return glb

    yield make
    for glb in glbs:
        glb.endGlobal()


# ---------------------------------------------------------------------------
# IGlobal — config
# ---------------------------------------------------------------------------


def test_begin_global_config_mode_skips(monkeypatch):
    glb = _real_global(monkeypatch, {}, open_mode='config')
    assert glb._loop is None  # no loop, no depends, no validation


def test_begin_global_requires_connection_string(monkeypatch):
    with pytest.raises(ValueError, match='connection_string is required'):
        _real_global(monkeypatch, {'connection_string': ''})


def test_begin_global_env_fallback(monkeypatch, bridge):
    monkeypatch.setenv('LASER_CONNECTION_STRING', 'iggy:laser@envhost:8090')
    glb = bridge(cfg={'connection_string': ''})
    assert glb.connection_string == 'iggy:laser@envhost:8090'


def test_begin_global_clamps_and_guards(bridge):
    glb = bridge(
        cfg={
            'connection_string': 'iggy:laser@localhost:8090',
            'recall_limit': 500,
            'op_timeout': 1,
            'folded': 'nope',
            'allow_namespace_override': 'nope',
        }
    )
    assert glb.recall_limit == 200
    assert glb.op_timeout == 5
    assert glb.folded is True  # non-bool falls back to default
    assert glb.allow_namespace_override is True
    assert glb.stream == 'rocketride-memory'  # default when unset


def test_begin_global_malformed_numbers_fall_back(bridge):
    glb = bridge(
        cfg={
            'connection_string': 'iggy:laser@localhost:8090',
            'recall_limit': 'lots',
            'op_timeout': 'forever',
        }
    )
    assert glb.recall_limit == 10  # malformed config must not crash beginGlobal
    assert glb.op_timeout == 30


def test_begin_global_zero_means_default(bridge):
    glb = bridge(cfg={'connection_string': 'iggy:laser@localhost:8090', 'op_timeout': 0, 'recall_limit': 0})
    assert glb.op_timeout == 30  # config_int semantics: <=0 is "unspecified"
    assert glb.recall_limit == 10


def test_begin_global_reads_stream(bridge, monkeypatch):
    glb = bridge(cfg={'connection_string': 'iggy:laser@localhost:8090', 'stream': 'shared-memory'})
    assert glb.stream == 'shared-memory'
    streams = []

    async def fake_connect(_conn, stream):
        streams.append(stream)
        return FakeLaser({'calls': []})

    monkeypatch.setattr(IGlobalMod, '_connect', fake_connect)
    glb.get_laser()
    assert streams == ['shared-memory']  # pinned at connect for laser.memory()


def test_validate_config_warns_without_raising(monkeypatch):
    warnings = []
    monkeypatch.setattr(IGlobalMod, 'warning', warnings.append)
    monkeypatch.delenv('LASER_CONNECTION_STRING', raising=False)

    class _Config:
        @staticmethod
        def getNodeConfig(*_a, **_k):
            return {}

    monkeypatch.setattr(IGlobalMod, 'Config', _Config)
    glb = IGlobal()
    glb.glb = SimpleNamespace(logicalType='tool_laserdata_memory', connConfig={})
    glb.validateConfig()
    assert warnings == ['connection_string is required']


# ---------------------------------------------------------------------------
# IGlobal — bridge
# ---------------------------------------------------------------------------


def test_run_executes_on_bridge_loop(bridge):
    glb = bridge()

    async def where():
        return threading.current_thread().name

    assert glb.run(where()) == 'tool_laserdata_memory-loop'


def test_run_timeout_maps_to_runtime_error(bridge):
    glb = bridge()

    async def slow():
        await asyncio.sleep(5)

    with pytest.raises(RuntimeError, match='timed out'):
        glb.run(slow(), timeout=0.05)


def test_run_when_not_open_raises():
    glb = IGlobal()

    async def noop():
        return 1

    with pytest.raises(RuntimeError, match='not open'):
        glb.run(noop())


def test_get_laser_connects_once_across_threads(bridge, monkeypatch):
    glb = bridge()
    state = {'calls': [], 'connects': 0}
    lock = threading.Lock()

    async def fake_connect(_conn, _stream):
        with lock:
            state['connects'] += 1
        await asyncio.sleep(0.05)  # widen the race window
        return FakeLaser(state)

    monkeypatch.setattr(IGlobalMod, '_connect', fake_connect)
    results = []
    threads = [threading.Thread(target=lambda: results.append(glb.get_laser())) for _ in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert state['connects'] == 1
    assert len(results) == 4 and all(r is results[0] for r in results)


async def _immediate(value):
    """Coroutine resolving immediately to `value`."""
    return value


def test_end_global_cancels_in_flight_calls(bridge):
    glb = bridge()
    results = []

    async def stuck():
        await asyncio.sleep(60)

    def call():
        t0 = time.monotonic()
        try:
            glb.run(stuck(), timeout=30)
            results.append(('returned', time.monotonic() - t0))
        except RuntimeError as exc:
            results.append((str(exc), time.monotonic() - t0))

    worker = threading.Thread(target=call)
    worker.start()
    deadline = time.monotonic() + 5
    while not glb._pending and time.monotonic() < deadline:
        time.sleep(0.01)
    assert glb._pending, 'call never registered as in-flight'
    glb.endGlobal()
    worker.join(timeout=5)
    assert not worker.is_alive()
    message, elapsed = results[0]
    assert message == 'laserdata: node is closing'
    assert elapsed < 5  # failed fast, not after the 30s op budget


def test_run_rejected_while_closing(bridge):
    glb = bridge()
    glb.endGlobal()

    async def noop():
        return 1

    with pytest.raises(RuntimeError, match='not open'):
        glb.run(noop())


def test_end_global_closes_and_clears(bridge, monkeypatch):
    glb = bridge(cfg={'connection_string': 'iggy:laser@localhost:8090'})
    state = {'calls': [], 'closed': False}
    monkeypatch.setattr(IGlobalMod, '_connect', lambda _c, _s: _immediate(FakeLaser(state)))
    glb.get_laser()
    loop = glb._loop
    glb.endGlobal()
    assert state['closed'] is True
    assert glb.connection_string == ''
    assert glb._laser is None and glb._loop is None
    assert loop.is_closed()
    glb.endGlobal()  # idempotent


# ---------------------------------------------------------------------------
# remember
# ---------------------------------------------------------------------------


def test_remember_requires_content():
    inst, _ = _instance()
    with pytest.raises(ValueError, match='"content" is required'):
        inst.remember({'content': '   '})


def test_remember_sends_verbatim_payload_and_conversation():
    inst, state = _instance()
    out = inst.remember({'content': '  padded fact  ', 'conversation': 'conv-1'})
    op, ns, payload, kwargs = state['calls'][0]
    assert (op, ns) == ('remember', 'ns-default')
    assert payload == '  padded fact  '  # user-authored content is never rewritten
    assert kwargs == {'conversation': 'conv-1'}
    assert out == {'memory_id': '01MEM', 'namespace': 'ns-default', 'conversation': 'conv-1'}


def test_remember_namespace_override():
    inst, state = _instance()
    out = inst.remember({'content': 'x', 'namespace': 'customer:42'})
    assert state['calls'][0][1] == 'customer:42'
    assert out['namespace'] == 'customer:42'


def test_namespace_override_disabled_rejects_other_namespace():
    inst, _ = _instance(allow_namespace_override=False)
    with pytest.raises(ValueError, match='override is disabled'):
        inst.remember({'content': 'x', 'namespace': 'other'})
    # Restating the configured namespace is not an override.
    out = inst.remember({'content': 'x', 'namespace': 'ns-default'})
    assert out['namespace'] == 'ns-default'


def test_namespace_required_when_unconfigured():
    inst, _ = _instance(namespace='')
    with pytest.raises(ValueError, match='a namespace is required'):
        inst.remember({'content': 'x'})


# ---------------------------------------------------------------------------
# recall
# ---------------------------------------------------------------------------


def test_recall_defaults_and_folded_flag():
    inst, state = _instance(recall_limit=7, folded=False)
    out = inst.recall({})
    op, ns, kwargs = state['calls'][0]
    assert (op, ns) == ('recall', 'ns-default')
    assert kwargs == {'limit': 7, 'folded': False}
    assert out == {'results': [], 'count': 0}


def test_recall_passes_query_strategy_conversation_and_clamps_limit():
    inst, state = _instance()
    inst.recall({'query': 'what fruit?', 'strategy': 'recent', 'conversation': 'c1', 'limit': 500})
    kwargs = state['calls'][0][2]
    assert kwargs['semantic'] == 'what fruit?'
    assert kwargs['strategy'] == 'recent'
    assert kwargs['conversation'] == 'c1'
    assert kwargs['limit'] == 200


def test_recall_non_int_limit_rejected():
    inst, _ = _instance(recall_limit=3)
    with pytest.raises(ValueError, match='"limit" must be an integer'):
        inst.recall({'limit': True})  # bool must not be treated as 1 (int_arg contract)


def test_recall_shapes_items():
    items = [
        FakeItem(id='01A', text='apples', score=0.9, conversation_id='c1', kind='note'),
        FakeItem(id='01B', text=None, payload=b'raw-bytes'),
        FakeItem(id='01C', text='plain', score=None),
    ]
    inst, _ = _instance({'calls': [], 'items': items})
    out = inst.recall({})
    assert out['count'] == 3
    assert out['results'][0] == {'id': '01A', 'text': 'apples', 'score': 0.9, 'conversation': 'c1', 'kind': 'note'}
    assert out['results'][1] == {'id': '01B', 'text': 'raw-bytes'}
    assert out['results'][2] == {'id': '01C', 'text': 'plain'}


def test_shape_items_tolerates_none():
    assert _shape_items(None) == []


# ---------------------------------------------------------------------------
# improve / forget
# ---------------------------------------------------------------------------


def test_improve_validates_weight():
    inst, _ = _instance()
    for bad in (None, True, 'high', float('nan'), float('inf')):
        with pytest.raises(ValueError, match='finite number'):
            inst.improve({'memory_id': '01A', 'weight': bad})


def test_improve_records_feedback():
    inst, state = _instance()
    out = inst.improve({'memory_id': '01A', 'weight': -1, 'conversation': 'c1'})
    op, ns, memory_id, weight, kwargs = state['calls'][0]
    assert (op, ns, memory_id) == ('improve', 'ns-default', '01A')
    assert weight == -1.0 and isinstance(weight, float)
    assert kwargs == {'conversation': 'c1'}
    assert out == {'feedback_id': '01FB', 'memory_id': '01A'}


def test_forget_requires_memory_id():
    inst, _ = _instance()
    with pytest.raises(ValueError, match='"memory_id" is required'):
        inst.forget({})


def test_forget_appends_tombstone():
    inst, state = _instance()
    out = inst.forget({'memory_id': '01A'})
    assert state['calls'][0] == ('forget', 'ns-default', '01A', {})
    assert out == {'forgotten': True, 'memory_id': '01A'}


# ---------------------------------------------------------------------------
# error mapping
# ---------------------------------------------------------------------------


def test_sdk_error_maps_to_runtime_error():
    inst, _ = _instance({'calls': [], 'raise': Exception('iggy unreachable')})
    with pytest.raises(RuntimeError, match=r'laserdata\.recall: iggy unreachable'):
        inst.recall({})


def test_sdk_error_scrubbed_of_credentials():
    cs = 'root:s3cretPW@laser.example.com:8090'
    state = {'calls': [], 'raise': Exception(f'dial failed for {cs} (auth s3cretPW rejected)')}
    inst, _ = _instance(state, connection_string=cs)
    with pytest.raises(RuntimeError) as ei:
        inst.recall({})
    text = str(ei.value)
    assert 's3cretPW' not in text  # secure-field password never reaches tool results/logs
    assert '<connection-string>' in text


def test_connect_failure_maps_to_runtime_error():
    inst, _ = _instance()

    def boom():
        raise Exception('Connection refused')

    inst.IGlobal.get_laser = boom
    with pytest.raises(RuntimeError, match=r'laserdata\.remember: connect failed'):
        inst.remember({'content': 'x'})


# ---------------------------------------------------------------------------
# agent-to-agent tasking: config, send_task, trace
# ---------------------------------------------------------------------------


def test_begin_global_normalizes_cloud_port(bridge):
    glb = bridge({'connection_string': 'u:p@x.laserdata.cloud', 'agent_id': 'intake'})
    assert glb.connection_string == 'u:p@x.laserdata.cloud:8090'
    assert glb.agent_id == 'intake'


def test_begin_global_rejects_portless_other_host(monkeypatch):
    with pytest.raises(ValueError, match='port'):
        _real_global(monkeypatch, {'connection_string': 'iggy:iggy@localhost'})


def test_begin_global_rejects_bad_agent_id(monkeypatch):
    with pytest.raises(ValueError, match='agent_id'):
        _real_global(monkeypatch, {'connection_string': 'iggy:laser@localhost:8090', 'agent_id': 'Intake Desk'})


def test_send_task_queues_and_records_event(fake_sdk):
    inst, state = _instance()
    out = inst.send_task({'to': 'risk', 'task': 'check refund 42'})
    assert out['status'] == 'queued' and out['to'] == 'risk'
    _, topic, env, prov = state['calls'][-1]
    assert topic == 'agent.risk.inbox' and env['body'] == 'check refund 42' and env['reply_to'] == 'agent.intake.inbox'
    assert prov['idempotency_key'] == f'task:{out["task_id"]}' and out['conversation_id'] == out['task_id']
    ev = state['topics']['agent.events'][-1].json()
    assert (ev['event'], ev['task_id']) == ('sent', out['task_id'])
    assert ('agent.risk.inbox', 1) in state['ensured']


def test_send_task_passes_conversation_and_parent(fake_sdk):
    inst, state = _instance()
    conv = '01M38G1CWHCSB0T13N308BYJXN'
    out = inst.send_task({'to': 'risk', 'task': 'x', 'conversation_id': conv, 'parent_task_id': 'p-1'})
    env = state['calls'][-1][2]
    assert (out['conversation_id'], env['conversation_id'], env['parent_task_id']) == (conv, conv, 'p-1')


def test_send_task_rejects_non_ulid_conversation(fake_sdk):
    inst, state = _instance()
    with pytest.raises(ValueError, match='conversation_id'):
        inst.send_task({'to': 'risk', 'task': 'x', 'conversation_id': 'conv-1'})
    assert not [c for c in state['calls'] if c[0] == 'send_agent']


def test_send_task_rejects_bad_target(fake_sdk):
    inst, state = _instance()
    with pytest.raises(ValueError, match='to'):
        inst.send_task({'to': 'Risk Desk', 'task': 'x'})
    assert not [c for c in state['calls'] if c[0] == 'send_agent']


def test_send_task_rejects_self(fake_sdk):
    inst, _ = _instance()
    with pytest.raises(ValueError, match='itself'):
        inst.send_task({'to': 'intake', 'task': 'x'})


def test_send_task_requires_configured_agent_id(fake_sdk):
    inst, _ = _instance(agent_id='')
    with pytest.raises(ValueError, match='Agent id'):
        inst.send_task({'to': 'risk', 'task': 'x'})


def _reply_on_poll(body, *, task_id=None):
    """on_poll hook: once the task is on the inbox, append its reply to intake's replies topic."""

    def hook(state, name):
        if name != 'agent.intake.replies':
            return
        sent = [c for c in state['calls'] if c[0] == 'send_agent']
        if not sent or state.get('replied'):
            return
        env = sent[-1][2]
        reply = dict(env, kind='reply', sender='risk', to='intake', body=body, task_id=task_id or env['task_id'])
        state['topics'].setdefault(name, []).append(SimpleNamespace(json=lambda r=reply: r))
        state['replied'] = True

    return hook


def test_send_task_wait_returns_done(fake_sdk):
    inst, state = _instance({'calls': [], 'on_poll': _reply_on_poll('approved')})
    out = inst.send_task({'to': 'risk', 'task': 'x', 'wait_secs': 5})
    assert (out['status'], out['result']) == ('done', 'approved')
    assert state['calls'][-1][2]['reply_to'] == 'agent.intake.replies'


def test_send_task_wait_ignores_other_replies(fake_sdk, monkeypatch):
    monkeypatch.setattr(IInstanceMod, '_WAIT_POLL_SECS', 0.01)
    old = SimpleNamespace(json=lambda: {'kind': 'reply', 'task_id': 'old', 'body': 'stale'})
    state = {
        'calls': [],
        'topics': {'agent.intake.replies': [old]},
        'on_poll': _reply_on_poll('other', task_id='someone-else'),
    }
    inst, _ = _instance(state)
    out = inst.send_task({'to': 'risk', 'task': 'x', 'wait_secs': 1})
    assert out['status'] == 'queued' and 'result' not in out


def test_send_task_wait_times_out_to_queued(fake_sdk, monkeypatch):
    monkeypatch.setattr(IInstanceMod, '_WAIT_POLL_SECS', 0.01)
    inst, _ = _instance()
    start = time.monotonic()
    out = inst.send_task({'to': 'risk', 'task': 'x', 'wait_secs': 1})
    assert out['status'] == 'queued' and time.monotonic() - start < 3


def test_trace_by_task_and_conversation(fake_sdk):
    inst, state = _instance()
    first = inst.send_task({'to': 'risk', 'task': 'a'})
    inst.send_task(
        {'to': 'payment', 'task': 'b', 'conversation_id': first['conversation_id'], 'parent_task_id': first['task_id']}
    )
    one = inst.trace({'task_id': first['task_id']})
    assert [r['status'] for r in one['tasks']] == ['queued']
    conv = inst.trace({'conversation_id': first['conversation_id']})
    assert [r['to'] for r in conv['tasks']] == ['risk', 'payment']


def test_trace_requires_a_key(fake_sdk):
    inst, _ = _instance()
    with pytest.raises(ValueError, match='task_id or conversation_id'):
        inst.trace({})
