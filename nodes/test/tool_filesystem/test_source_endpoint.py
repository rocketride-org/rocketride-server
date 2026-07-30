# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================
"""Tests for the File Store Source endpoint (scan + push)."""

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
    rl.getObject = getattr(rl, 'getObject', lambda obj=None, **k: types.SimpleNamespace(**(obj or {})))
    rl.monitorCompleted = getattr(rl, 'monitorCompleted', lambda n: None)
    rl.monitorFailed = getattr(rl, 'monitorFailed', lambda n: None)
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


class _FakePipe:
    def __init__(self):
        self.calls = []

    def __getattr__(self, name):
        def record(*args):
            self.calls.append((name, args))

        return record


def _endpoint(mod, files, *, path='inbox', recursive=False, client_id='c1', monkeypatch=None):
    if monkeypatch is not None:
        monkeypatch.setenv('ROCKETRIDE_CLIENT_ID', client_id)
    store = _FakeStore(files)
    mod.Store = MagicMock()
    mod.Store.create.return_value.get_file_store.return_value = store
    ep = mod.IEndpoint()
    pipes = []

    def get_pipe():
        p = _FakePipe()
        pipes.append(p)
        return p

    target = MagicMock()
    target.getPipe.side_effect = get_pipe
    ep.endpoint = types.SimpleNamespace(
        serviceConfig={'parameters': {'path': path, 'recursive': recursive}},
        target=target,
    )
    return ep, pipes, target


def _pushed_paths(pipes):
    return [dict(p.calls)['open'][0].name for p in pipes]


def test_single_file_pushed_with_tag_stream_sequence(monkeypatch):
    mod = _load_endpoint_module()
    ep, pipes, target = _endpoint(mod, {'inbox/a.pdf': b'PDFDATA'}, path='inbox/a.pdf', monkeypatch=monkeypatch)
    ep.scanObjects('', lambda e: 0)
    assert len(pipes) == 1
    names = [c[0] for c in pipes[0].calls]
    assert names == [
        'open',
        'writeTagBeginObject',
        'writeTagBeginStream',
        'writeTagData',
        'writeTagEndStream',
        'writeTagEndObject',
        'close',
    ]
    assert dict(pipes[0].calls)['writeTagData'] == (b'PDFDATA',)
    entry = dict(pipes[0].calls)['open'][0]
    assert entry.name == 'inbox/a.pdf'
    assert entry.url == 'filestore://inbox/a.pdf'
    assert entry.size == 7
    assert entry.mimeType == 'application/pdf'
    target.putPipe.assert_called_once_with(pipes[0])


def test_folder_non_recursive_skips_subfolders(monkeypatch):
    mod = _load_endpoint_module()
    ep, pipes, _t = _endpoint(
        mod,
        {'inbox/a.txt': b'A', 'inbox/sub/b.txt': b'B'},
        path='inbox',
        recursive=False,
        monkeypatch=monkeypatch,
    )
    ep.scanObjects('', lambda e: 0)
    assert _pushed_paths(pipes) == ['inbox/a.txt']


def test_folder_recursive_descends(monkeypatch):
    mod = _load_endpoint_module()
    ep, pipes, _t = _endpoint(
        mod,
        {'inbox/a.txt': b'A', 'inbox/sub/b.txt': b'B', 'inbox/sub/deep/c.txt': b'C'},
        path='inbox',
        recursive=True,
        monkeypatch=monkeypatch,
    )
    ep.scanObjects('', lambda e: 0)
    assert _pushed_paths(pipes) == ['inbox/a.txt', 'inbox/sub/b.txt', 'inbox/sub/deep/c.txt']


def test_missing_path_raises(monkeypatch):
    mod = _load_endpoint_module()
    ep, _p, _t = _endpoint(mod, {}, path='nope', monkeypatch=monkeypatch)
    with pytest.raises(ValueError, match='does not exist'):
        ep.scanObjects('', lambda e: 0)


def test_missing_client_id_raises(monkeypatch):
    mod = _load_endpoint_module()
    ep, _p, _t = _endpoint(mod, {'inbox/a.txt': b'A'}, path='inbox', monkeypatch=monkeypatch)
    monkeypatch.delenv('ROCKETRIDE_CLIENT_ID', raising=False)
    with pytest.raises(ValueError, match='ROCKETRIDE_CLIENT_ID'):
        ep.scanObjects('', lambda e: 0)


def test_read_failure_continues_with_next_file(monkeypatch):
    mod = _load_endpoint_module()
    ep, pipes, target = _endpoint(
        mod, {'inbox/a.txt': b'A', 'inbox/b.txt': b'B'}, path='inbox', monkeypatch=monkeypatch
    )
    store = mod.Store.create.return_value.get_file_store.return_value
    orig_read = store.read

    async def flaky_read(path, connection_id=0, max_size=None):
        if path.endswith('a.txt'):
            raise RuntimeError('boom')
        return await orig_read(path)

    store.read = flaky_read
    ep.scanObjects('', lambda e: 0)
    # a.txt failed but b.txt still made it through; every acquired pipe returned.
    assert _pushed_paths(pipes) == ['inbox/b.txt']
    assert target.putPipe.call_count == len(pipes)


def test_validate_config_requires_path(monkeypatch):
    mod = _load_endpoint_module()
    ep, _p, _t = _endpoint(mod, {}, path='', monkeypatch=monkeypatch)
    with pytest.raises(ValueError, match='path'):
        ep.validateConfig(False)
