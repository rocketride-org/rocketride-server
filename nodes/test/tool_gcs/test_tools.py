# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Unit tests for tool_gcs download size-cap, prefix joining, and the retained download.

These are pure-Python unit tests — no server, no live GCS. The node module is
imported under a stubbed ``rocketlib`` so ``IInstance.py`` / ``IGlobal.py``
resolve without the engine runtime.
"""

from __future__ import annotations

import itertools
import sys
import types
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import MagicMock

import pytest

_NODE_DIR = Path(__file__).resolve().parent.parent.parent / 'src' / 'nodes' / 'tool_gcs'

_STUB_MODULE_NAMES = ('rocketlib', 'ai', 'ai.common')


def _tool_function(**meta):
    def wrap(fn):
        fn.__tool_meta__ = meta
        return fn

    return wrap


def _install_stubs() -> None:
    stub = types.ModuleType('rocketlib')

    class _IInstanceBase:
        pass

    class _IGlobalBase:
        pass

    stub.IInstanceBase = _IInstanceBase
    stub.IGlobalBase = _IGlobalBase
    stub.tool_function = _tool_function
    stub.OPEN_MODE = types.SimpleNamespace(CONFIG='config')
    stub.debug = lambda *a, **kw: None
    stub.warning = lambda *a, **kw: None
    sys.modules['rocketlib'] = stub

    ai = types.ModuleType('ai')
    ai_common = types.ModuleType('ai.common')
    ai.common = ai_common
    sys.modules['ai'] = ai
    sys.modules['ai.common'] = ai_common

    if 'tool_gcs' not in sys.modules:
        pkg = types.ModuleType('tool_gcs')
        pkg.__path__ = [str(_NODE_DIR)]
        sys.modules['tool_gcs'] = pkg


@contextmanager
def _scoped_stubs() -> Iterator[None]:
    original = {name: sys.modules.get(name) for name in _STUB_MODULE_NAMES}
    added_pkg = 'tool_gcs' not in sys.modules
    _install_stubs()
    try:
        yield
    finally:
        for name, module in original.items():
            if module is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = module
        if added_pkg:
            for name in list(sys.modules):
                if name == 'tool_gcs' or name.startswith('tool_gcs.'):
                    sys.modules.pop(name, None)


with _scoped_stubs():
    import tool_gcs.IInstance as instance_module  # noqa: E402
    from tool_gcs.IGlobal import IGlobal  # noqa: E402
    from tool_gcs.IInstance import IInstance, download_path, join_gcs_prefix  # noqa: E402


@pytest.fixture(autouse=True)
def download_ids(monkeypatch):
    """Number the downloads 0001, 0002, ... instead of drawing random ids."""
    ids = itertools.count(1)
    monkeypatch.setattr(instance_module, 'secrets', types.SimpleNamespace(token_hex=lambda n: f'{next(ids):04d}'))


def test_join_gcs_prefix_empty():
    assert join_gcs_prefix('', '') == ''
    assert join_gcs_prefix('', 'images') == 'images'
    assert join_gcs_prefix('', '/images/') == 'images/'


def test_join_gcs_prefix_node_only():
    assert join_gcs_prefix('data', '') == 'data/'
    assert join_gcs_prefix('data/', '') == 'data/'


def test_join_gcs_prefix_combines_and_strips_slashes():
    assert join_gcs_prefix('data', 'images') == 'data/images'
    assert join_gcs_prefix('data/', '/images/foo') == 'data/images/foo'


class _Files:
    """Stand-in for ``self.files``: paths to bytes."""

    def __init__(self):
        self.stored = {}

    def write(self, path, data):
        self.stored[path] = bytes(data)

    def delete(self, path):
        self.stored.pop(path, None)


class _State:
    """Stand-in for ``self.state``: a dict with a no-op lock."""

    def __init__(self):
        self.values = {}

    def get(self, key, default=None):
        return self.values.get(key, default)

    def put(self, key, value, ttl=None):
        self.values[key] = value

    @contextmanager
    def lock(self, key):
        yield


class _Reader:
    """A blob stream: serves ``data`` up to the size asked for."""

    def __init__(self, data):
        self._data = data

    def read(self, size):
        return self._data[:size]

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def _make_instance(*, prefix='data', max_download_bytes=100, blob=None, names=None):
    client = MagicMock()
    bucket = MagicMock()
    client.bucket.return_value = bucket
    if blob is not None:
        bucket.blob.return_value = blob
    if names is not None:
        bucket.list_blobs.return_value = [types.SimpleNamespace(name=n) for n in names]
    glb = IGlobal.__new__(IGlobal)
    glb.client = client
    inst = IInstance()
    inst.IGlobal = glb
    # This call's settings and the binding's doors (the stubbed base has none of its own)
    inst.settings = types.SimpleNamespace(bucketName='my-bucket', prefix=prefix, maxDownloadBytes=max_download_bytes)
    inst.files = _Files()
    inst.state = _State()
    return inst, client, bucket


def _blob(data, size=None):
    """A blob whose listed size is ``size`` and whose stream serves ``data``."""
    blob = MagicMock()
    blob.size = len(data) if size is None else size
    blob.open.side_effect = lambda mode: _Reader(data)
    return blob


def test_list_files_joins_node_and_runtime_prefix():
    inst, _client, bucket = _make_instance(prefix='data', names=['data/images/a.txt'])

    result = inst.list_files({'prefix': '/images/', 'max_results': 5})

    assert result == ['data/images/a.txt']
    bucket.list_blobs.assert_called_once_with(prefix='data/images/', max_results=5)


def test_list_files_node_prefix_only():
    inst, _client, bucket = _make_instance(prefix='data', names=[])

    inst.list_files()

    bucket.list_blobs.assert_called_once_with(prefix='data/', max_results=10)


def test_download_file_rejects_oversize_before_fetch():
    blob = _blob(b'x' * 200)
    inst, _client, _bucket = _make_instance(max_download_bytes=100, blob=blob)

    result = inst.download_file({'file_name': 'big.bin'})

    assert 'error' in result
    assert 'exceeds' in result['error']
    blob.open.assert_not_called()
    assert inst.files.stored == {}


def test_download_file_rejects_if_fetched_size_grows():
    blob = _blob(b'x' * 200, size=10)
    inst, _client, _bucket = _make_instance(max_download_bytes=100, blob=blob)

    result = inst.download_file({'file_name': 'swap.bin'})

    assert 'error' in result
    assert 'grew past' in result['error']
    assert inst.files.stored == {}
    assert inst.state.get('last_download') is None


def test_download_file_success_and_replaces_previous():
    inst, _client, bucket = _make_instance(prefix='data', max_download_bytes=100, blob=_blob(b'data'))

    first = inst.download_file({'file_name': 'a.txt'})
    assert first == {'success': True, 'path': 'gcs/data/0001-a.txt', 'size': 4}
    bucket.blob.assert_called_with('data/a.txt')
    assert inst.files.stored == {'gcs/data/0001-a.txt': b'data'}

    second = inst.download_file({'file_name': 'b.txt'})
    assert second == {'success': True, 'path': 'gcs/data/0002-b.txt', 'size': 4}
    assert inst.files.stored == {'gcs/data/0002-b.txt': b'data'}
    assert inst.state.get('last_download') == 'gcs/data/0002-b.txt'


def test_download_path_keeps_the_object_path_inside_the_download_root():
    assert download_path('data/a.txt', '0001') == 'gcs/data/0001-a.txt'
    assert download_path('../../etc/passwd', '0001') == 'gcs/etc/0001-passwd'
    assert download_path('', '0001') == 'gcs/0001-object'


def test_two_nodes_of_one_owner_never_delete_each_others_downloads():
    # One owner's file store, two tool_gcs nodes (each with its own state)
    # downloading an object of the same name
    first, _client, _bucket = _make_instance(prefix='', blob=_blob(b'data'))
    second, _client, _bucket = _make_instance(prefix='', blob=_blob(b'data'))
    second.files = first.files
    first.download_file({'file_name': 'a.txt'})
    second.download_file({'file_name': 'a.txt'})
    first.download_file({'file_name': 'b.txt'})
    # The first node's next download replaced its own file only
    assert second.state.get('last_download') == 'gcs/0002-a.txt'
    assert first.files.stored == {'gcs/0002-a.txt': b'data', 'gcs/0003-b.txt': b'data'}


def test_a_concurrent_download_never_leaves_the_record_on_a_deleted_file():
    # The record names a.txt. One call downloads a.txt again; while its bytes
    # are being written, another call of the node downloads b.txt and finishes
    # first, deleting the previous download. The record must name a file that
    # exists, and the first call's own file must not be the one deleted.
    rewrite, _client, _bucket = _make_instance(prefix='', blob=_blob(b'data'))
    other, _client, _bucket = _make_instance(prefix='', blob=_blob(b'data'))
    other.files, other.state = rewrite.files, rewrite.state
    rewrite.download_file({'file_name': 'a.txt'})

    files = rewrite.files
    write = files.write
    interleaved = []

    def write_then_let_the_other_call_finish(path, data):
        write(path, data)
        if not interleaved:
            interleaved.append(None)
            interleaved[0] = other.download_file({'file_name': 'b.txt'})

    files.write = write_then_let_the_other_call_finish
    assert rewrite.download_file({'file_name': 'a.txt'}) == {'success': True, 'path': 'gcs/0002-a.txt', 'size': 4}
    assert interleaved[0] == {'success': True, 'path': 'gcs/0003-b.txt', 'size': 4}
    assert rewrite.state.get('last_download') == 'gcs/0002-a.txt'
    assert files.stored == {'gcs/0002-a.txt': b'data'}


def test_a_download_whose_record_fails_leaves_no_file():
    inst, _client, _bucket = _make_instance(prefix='', blob=_blob(b'data'))

    def refuse(key, value, ttl=None):
        raise RuntimeError('state.put refused')

    inst.state.put = refuse
    assert 'refused' in inst.download_file({'file_name': 'a.txt'})['error']
    assert inst.files.stored == {}
