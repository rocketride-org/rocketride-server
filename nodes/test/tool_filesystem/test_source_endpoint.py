# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================
"""Tests for the File Store Source endpoint (scan callback + render)."""

from __future__ import annotations

import importlib.util
import sys
import types
from unittest.mock import MagicMock

import pytest

from test_sink_naming import _install_stubs, _NODE_DIR


def _install_endpoint_stubs():
    """Extend the shared stubs with the endpoint-side rocketlib surface."""
    _install_stubs()
    rl = sys.modules['rocketlib']
    if not hasattr(rl, 'IEndpointBase'):
        rl.IEndpointBase = type('IEndpointBase', (), {})
    rl.debug = getattr(rl, 'debug', lambda *a, **k: None)


def _load_endpoint_module():
    _install_endpoint_stubs()
    spec = importlib.util.spec_from_file_location('tfs_iendpoint_real', str(_NODE_DIR / 'IEndpoint.py'))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class _FakeStore:
    """Async FileStore stub over a dict of {relative_path: bytes}."""

    def __init__(self, files):
        self.files = dict(files)

    async def stat(self, path):
        p = path.strip('/')
        if p in self.files:
            return {'exists': True, 'type': 'file', 'size': len(self.files[p])}
        if any(k.startswith(p + '/') for k in self.files):
            return {'exists': True, 'type': 'dir'}
        return {'exists': False}

    async def list_dir(self, path=''):
        p = path.strip('/')
        prefix = f'{p}/' if p else ''
        names = {}
        for k in self.files:
            if not k.startswith(prefix):
                continue
            rest = k[len(prefix) :]
            head = rest.split('/')[0]
            if '/' in rest:
                names[head] = {'name': head, 'type': 'dir'}
            else:
                names.setdefault(head, {'name': head, 'type': 'file', 'size': len(self.files[k])})
        return {'entries': [names[n] for n in sorted(names)], 'count': len(names)}

    async def read(self, path, connection_id=0, max_size=None):
        return self.files[path.strip('/')]


class _FakeInstance:
    """Records the engine sendTag* calls issued during a render."""

    def __init__(self):
        self.calls = []

    def __getattr__(self, name):
        def record(*args):
            self.calls.append((name, args))

        return record


def _endpoint(mod, files, *, path='inbox', recursive=False, monkeypatch=None):
    store = _FakeStore(files)
    mod.Store = MagicMock()
    mod.Store.engine_file_store.return_value = store
    ep = mod.IEndpoint()
    ep.endpoint = types.SimpleNamespace(
        serviceConfig={'parameters': {'path': path, 'recursive': recursive}},
    )
    return ep


def _scan(ep, ret=0):
    """Run scanObjects, returning the entries reported to the engine callback."""
    entries = []

    def callback(entry):
        entries.append(entry)
        return ret

    ep.scanObjects('', callback)
    return entries


# ---------------------------------------------------------------------------
# scanObjects: enumeration through the engine scan callback
# ---------------------------------------------------------------------------


def test_single_file_reported_with_name_and_size(monkeypatch):
    mod = _load_endpoint_module()
    ep = _endpoint(mod, {'inbox/a.pdf': b'PDFDATA'}, path='inbox/a.pdf', monkeypatch=monkeypatch)
    assert _scan(ep) == [{'name': 'inbox/a.pdf', 'size': 7}]


def test_folder_non_recursive_skips_subfolders(monkeypatch):
    mod = _load_endpoint_module()
    ep = _endpoint(
        mod,
        {'inbox/a.txt': b'A', 'inbox/sub/b.txt': b'B'},
        path='inbox',
        recursive=False,
        monkeypatch=monkeypatch,
    )
    assert [e['name'] for e in _scan(ep)] == ['inbox/a.txt']


def test_folder_recursive_descends(monkeypatch):
    mod = _load_endpoint_module()
    ep = _endpoint(
        mod,
        {'inbox/a.txt': b'A', 'inbox/sub/b.txt': b'B', 'inbox/sub/deep/c.txt': b'C'},
        path='inbox',
        recursive=True,
        monkeypatch=monkeypatch,
    )
    assert [e['name'] for e in _scan(ep)] == ['inbox/a.txt', 'inbox/sub/b.txt', 'inbox/sub/deep/c.txt']


def test_nonzero_callback_return_stops_enumeration(monkeypatch):
    # The engine returns -1 from the callback on cancellation/license limit.
    mod = _load_endpoint_module()
    ep = _endpoint(mod, {'inbox/a.txt': b'A', 'inbox/b.txt': b'B'}, path='inbox', monkeypatch=monkeypatch)
    assert len(_scan(ep, ret=-1)) == 1


def test_missing_path_raises(monkeypatch):
    mod = _load_endpoint_module()
    ep = _endpoint(mod, {}, path='nope', monkeypatch=monkeypatch)
    with pytest.raises(ValueError, match='does not exist'):
        ep.scanObjects('', lambda e: 0)


def test_empty_path_raises_instead_of_scanning_store_root(monkeypatch):
    # D1 regression: an empty/undelivered 'path' must hard-fail, never fall
    # through to enumerating the entire account store root.
    mod = _load_endpoint_module()
    ep = _endpoint(mod, {'somewhere/a.txt': b'A'}, path='', monkeypatch=monkeypatch)
    with pytest.raises(ValueError, match='"path" is required'):
        ep.scanObjects('', lambda e: 0)


def test_blank_path_raises(monkeypatch):
    mod = _load_endpoint_module()
    ep = _endpoint(mod, {'somewhere/a.txt': b'A'}, path='  / ', monkeypatch=monkeypatch)
    with pytest.raises(ValueError, match='"path" is required'):
        ep.scanObjects('', lambda e: 0)


def test_no_task_identity_raises(monkeypatch):
    # Store.engine_file_store() returns None when no task is running or the
    # task carries no identity — the scan must fail loudly, not silently no-op.
    mod = _load_endpoint_module()
    ep = _endpoint(mod, {'inbox/a.txt': b'A'}, path='inbox', monkeypatch=monkeypatch)
    mod.Store.engine_file_store.return_value = None
    with pytest.raises(ValueError, match='task'):
        ep.scanObjects('', lambda e: 0)


# ---------------------------------------------------------------------------
# renderStoreObject: content delivery for a queued entry
# ---------------------------------------------------------------------------


def test_render_sends_tag_stream_sequence(monkeypatch):
    mod = _load_endpoint_module()
    ep = _endpoint(mod, {'inbox/a.pdf': b'PDFDATA'}, monkeypatch=monkeypatch)
    inst = _FakeInstance()
    ep.renderStoreObject(types.SimpleNamespace(name='inbox/a.pdf'), inst)
    assert [c[0] for c in inst.calls] == [
        'sendTagBeginObject',
        'sendTagBeginStream',
        'sendTagData',
        'sendTagEndStream',
        'sendTagEndObject',
        # Explicit per-object close: the dev-mode runner (unlike task-mode
        # processItem) never closes the object for the source, leaving it
        # PROCESSING forever in the trace. Close is idempotent engine-side,
        # so task mode is unaffected. Same contract as telegram/webhook.
        'sendClose',
    ]
    assert dict(inst.calls)['sendTagData'] == (b'PDFDATA',)


def test_render_strips_engine_root_slash(monkeypatch):
    # DIRECT mode builds the object path as '/' / name; the store read must
    # still resolve relative to the account root.
    mod = _load_endpoint_module()
    ep = _endpoint(mod, {'inbox/a.txt': b'A'}, monkeypatch=monkeypatch)
    inst = _FakeInstance()
    ep.renderStoreObject(types.SimpleNamespace(name='/inbox/a.txt'), inst)
    assert dict(inst.calls)['sendTagData'] == (b'A',)


def test_render_read_failure_propagates_before_any_send(monkeypatch):
    # The engine marks the entry failed from the raised error; no partial
    # tag frames may be emitted for the failed object.
    mod = _load_endpoint_module()
    ep = _endpoint(mod, {}, monkeypatch=monkeypatch)
    inst = _FakeInstance()
    with pytest.raises(KeyError):
        ep.renderStoreObject(types.SimpleNamespace(name='inbox/missing.txt'), inst)
    assert inst.calls == []


# ---------------------------------------------------------------------------
# IInstance.renderObject: engine render entry point delegates to the endpoint
# ---------------------------------------------------------------------------


def test_instance_render_object_delegates_and_prevents_default():
    from test_sink_naming import _fs, _sink_instance

    inst = _sink_instance(_fs())
    entry = types.SimpleNamespace(name='inbox/a.txt')

    calls = []
    inst.IEndpoint = types.SimpleNamespace(renderStoreObject=lambda e, i: calls.append((e, i)))
    assert inst.renderObject(entry) == 'PREVENT_DEFAULT'
    assert calls == [(entry, inst.instance)]


def test_instance_render_object_falls_through_without_source_endpoint():
    # Sink/tool variants: no renderStoreObject on the endpoint — the engine
    # default must run (no preventDefault).
    from test_sink_naming import _fs, _sink_instance

    inst = _sink_instance(_fs())
    inst.IEndpoint = types.SimpleNamespace()
    assert inst.renderObject(types.SimpleNamespace(name='x')) is None


# ---------------------------------------------------------------------------
# validateConfig
# ---------------------------------------------------------------------------


def test_validate_config_requires_path(monkeypatch):
    mod = _load_endpoint_module()
    ep = _endpoint(mod, {}, path='', monkeypatch=monkeypatch)
    with pytest.raises(ValueError, match='path'):
        ep.validateConfig(False)


# ---------------------------------------------------------------------------
# pydevd foreign-thread registration (designer/debugpy dev-mode wedge)
# ---------------------------------------------------------------------------


def _render_ready_instance():
    from test_sink_naming import _fs, _sink_instance

    inst = _sink_instance(_fs())
    inst.IEndpoint = types.SimpleNamespace(renderStoreObject=lambda e, i: None)
    return inst, sys.modules['tool_filesystem.IInstance']


def test_render_registers_thread_with_pydevd_once(monkeypatch):
    inst, mod = _render_ready_instance()
    fake_pydevd = MagicMock()
    monkeypatch.setitem(sys.modules, 'pydevd', fake_pydevd)
    monkeypatch.setattr(mod, '_DEBUGGER_THREADS', set())

    inst.renderObject(types.SimpleNamespace(name='a.txt'))
    fake_pydevd.settrace.assert_called_once_with(suspend=False)
    inst.renderObject(types.SimpleNamespace(name='b.txt'))
    fake_pydevd.settrace.assert_called_once()  # same thread: not re-registered


def test_render_without_pydevd_is_a_noop(monkeypatch):
    inst, mod = _render_ready_instance()
    monkeypatch.delitem(sys.modules, 'pydevd', raising=False)
    monkeypatch.setattr(mod, '_DEBUGGER_THREADS', set())
    assert inst.renderObject(types.SimpleNamespace(name='a.txt')) == 'PREVENT_DEFAULT'


def test_render_survives_pydevd_settrace_failure(monkeypatch):
    # A broken debugger must not fail the render; and the thread must not be
    # retried on every object (one warning, not a warning per file).
    inst, mod = _render_ready_instance()
    fake_pydevd = MagicMock()
    fake_pydevd.settrace.side_effect = RuntimeError('adapter gone')
    monkeypatch.setitem(sys.modules, 'pydevd', fake_pydevd)
    monkeypatch.setattr(mod, '_DEBUGGER_THREADS', set())

    assert inst.renderObject(types.SimpleNamespace(name='a.txt')) == 'PREVENT_DEFAULT'
    inst.renderObject(types.SimpleNamespace(name='b.txt'))
    fake_pydevd.settrace.assert_called_once()


def test_recursive_scan_bounds_directory_cycles(monkeypatch):
    # A backend reporting symlinked dirs yields endless distinct paths; the
    # scan must abort with a clear error instead of hanging.
    mod = _load_endpoint_module()
    monkeypatch.setattr(mod, '_MAX_SCAN_FOLDERS', 5)

    class _CycleStore(_FakeStore):
        async def stat(self, path):
            return {'exists': True, 'type': 'dir'}

        async def list_dir(self, path=''):
            # Self-limiting: if the folder cap ever regresses, fail fast here
            # instead of walking this fake forever.
            self.calls = getattr(self, 'calls', 0) + 1
            assert self.calls <= 50, 'scan not bounded: cycling list_dir called past the cap'
            return {'entries': [{'name': 'loop', 'type': 'dir'}], 'count': 1}

    mod.Store = MagicMock()
    mod.Store.engine_file_store.return_value = _CycleStore({})
    ep = mod.IEndpoint()
    ep.endpoint = types.SimpleNamespace(
        serviceConfig={'parameters': {'path': 'inbox', 'recursive': True}},
    )
    with pytest.raises(ValueError, match='exceeded 5 folders'):
        ep.scanObjects('', lambda e: 0)
