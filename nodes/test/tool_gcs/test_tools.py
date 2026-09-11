# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Unit tests for tool_gcs download size-cap, prefix joining, and temp-file retention.

These are pure-Python unit tests — no server, no live GCS. The node module is
imported under a stubbed ``rocketlib`` so ``IInstance.py`` / ``IGlobal.py``
resolve without the engine runtime.
"""

from __future__ import annotations

import sys
import types
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import MagicMock

_NODE_DIR = Path(__file__).resolve().parent.parent.parent / 'src' / 'nodes' / 'tool_gcs'

_STUB_MODULE_NAMES = ('rocketlib', 'ai', 'ai.common', 'ai.common.config')


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
    ai_common_config = types.ModuleType('ai.common.config')
    ai_common_config.Config = type('Config', (), {})
    ai.common = ai_common
    ai_common.config = ai_common_config
    sys.modules['ai'] = ai
    sys.modules['ai.common'] = ai_common
    sys.modules['ai.common.config'] = ai_common_config

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
    from tool_gcs.IGlobal import IGlobal  # noqa: E402
    from tool_gcs.IInstance import IInstance, join_gcs_prefix  # noqa: E402


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
    glb.bucket_name = 'my-bucket'
    glb.prefix = prefix
    glb.max_download_bytes = max_download_bytes
    glb.temp_files = []

    inst = IInstance()
    inst.IGlobal = glb
    return inst, client, bucket


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
    blob = MagicMock()
    blob.size = 200
    inst, _client, bucket = _make_instance(max_download_bytes=100, blob=blob)

    result = inst.download_file({'file_name': 'big.bin'})

    assert 'error' in result
    assert 'exceeds' in result['error']
    blob.download_to_filename.assert_not_called()
    assert inst.IGlobal.temp_files == []


def test_download_file_rejects_if_fetched_size_grows():
    blob = MagicMock()
    blob.size = 10

    def _write_large(path):
        Path(path).write_bytes(b'x' * 200)

    blob.download_to_filename.side_effect = _write_large
    inst, _client, _bucket = _make_instance(max_download_bytes=100, blob=blob)

    result = inst.download_file({'file_name': 'swap.bin'})

    assert 'error' in result
    assert 'downloaded' in result['error']
    assert inst.IGlobal.temp_files == []
    blob.download_to_filename.assert_called_once()


def test_download_file_success_and_evicts_previous():
    blob = MagicMock()
    blob.size = 4

    def _write(path):
        Path(path).write_bytes(b'data')

    blob.download_to_filename.side_effect = _write
    inst, _client, bucket = _make_instance(prefix='data', max_download_bytes=100, blob=blob)

    first = inst.download_file({'file_name': 'a.txt'})
    assert first.get('success') is True
    first_path = first['local_path']
    assert Path(first_path).exists()
    bucket.blob.assert_called_with('data/a.txt')

    second = inst.download_file({'file_name': 'b.txt'})
    assert second.get('success') is True
    second_path = second['local_path']
    assert Path(second_path).exists()
    assert not Path(first_path).exists()
    assert inst.IGlobal.temp_files == [second_path]

    inst.IGlobal.endGlobal()
    assert not Path(second_path).exists()
    assert inst.IGlobal.temp_files is None
