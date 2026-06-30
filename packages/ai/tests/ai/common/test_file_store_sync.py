# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the 'Software'), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================
"""Tests for _SyncFileStoreShim: read_bytes, stat, and read_chunks."""

from __future__ import annotations

import pytest

from ai.common.file_store import _SyncFileStoreShim


# ---------------------------------------------------------------------------
# Async stub inner store
# ---------------------------------------------------------------------------


class _AsyncInnerStub:
    """Minimal async file-store stub; tracks read_chunk call count."""

    def __init__(self, content_by_path: dict[str, bytes]):
        self._content = content_by_path
        self.read_chunk_calls: int = 0
        self.close_read_calls: int = 0

    async def read(self, path: str) -> bytes:
        return self._content[path]

    async def stat(self, path: str) -> dict:
        data = self._content[path]
        return {'exists': True, 'type': 'file', 'size': len(data), 'modified': 0.0}

    async def open_read(self, path: str, connection_id: int) -> dict:
        return {'handle': path, 'size': len(self._content[path])}

    async def read_chunk(
        self,
        handle_id: str,
        offset: int,
        length: int = 4 * 1024 * 1024,
        connection_id: int = 0,
    ) -> bytes:
        self.read_chunk_calls += 1
        data = self._content[handle_id]
        return data[offset : offset + length]

    async def close_read(self, handle_id: str, connection_id: int = 0) -> None:
        self.close_read_calls += 1


# ---------------------------------------------------------------------------
# Tests: read_bytes (existing behaviour — document and guard the refactor)
# ---------------------------------------------------------------------------


def test_read_bytes_returns_file_content():
    """read_bytes delegates to inner.read and returns the raw bytes."""
    content = b'hello shim'
    inner = _AsyncInnerStub({'myfile.txt': content})
    shim = _SyncFileStoreShim(inner)
    assert shim.read_bytes('myfile.txt') == content


# ---------------------------------------------------------------------------
# Tests: stat
# ---------------------------------------------------------------------------


def test_stat_returns_size():
    """stat() returns a dict whose 'size' key equals the file length."""
    data = b'x' * 42
    inner = _AsyncInnerStub({'path/to/blob': data})
    shim = _SyncFileStoreShim(inner)
    result = shim.stat('path/to/blob')
    assert result['size'] == 42


def test_stat_returns_full_inner_dict():
    """stat() passes through the full dict returned by inner.stat."""
    data = b'abc'
    inner = _AsyncInnerStub({'f': data})
    shim = _SyncFileStoreShim(inner)
    result = shim.stat('f')
    assert result['exists'] is True
    assert result['type'] == 'file'
    assert 'modified' in result


# ---------------------------------------------------------------------------
# Tests: read_chunks
# ---------------------------------------------------------------------------


def test_read_chunks_reconstructs_file():
    """Joining all chunks from read_chunks reproduces the original bytes."""
    data = b'abcdefghij'  # 10 bytes
    inner = _AsyncInnerStub({'test.bin': data})
    shim = _SyncFileStoreShim(inner)
    result = b''.join(shim.read_chunks('test.bin', chunk_size=4))
    assert result == data


def test_read_chunks_issues_multiple_read_chunk_calls():
    """read_chunks calls inner.read_chunk more than once when file > chunk_size."""
    data = b'0123456789ab'  # 12 bytes, chunk_size=4 → 3 calls
    inner = _AsyncInnerStub({'big.bin': data})
    shim = _SyncFileStoreShim(inner)
    list(shim.read_chunks('big.bin', chunk_size=4))
    assert inner.read_chunk_calls >= 2


def test_read_chunks_exact_multiple_of_chunk_size():
    """read_chunks handles a file whose size is an exact multiple of chunk_size."""
    data = b'12345678'  # 8 bytes, chunk_size=4 → 2 data chunks + 1 empty (EOF)
    inner = _AsyncInnerStub({'exact.bin': data})
    shim = _SyncFileStoreShim(inner)
    result = b''.join(shim.read_chunks('exact.bin', chunk_size=4))
    assert result == data


def test_read_chunks_closes_handle_in_finally():
    """close_read is called exactly once even when iteration completes normally."""
    data = b'abc'
    inner = _AsyncInnerStub({'f.bin': data})
    shim = _SyncFileStoreShim(inner)
    list(shim.read_chunks('f.bin', chunk_size=4))
    assert inner.close_read_calls == 1


def test_read_chunks_closes_handle_on_error():
    """close_read is still called when open_read succeeds but read_chunk raises."""

    class _ErrorAfterOpenStub:
        close_read_calls = 0

        async def open_read(self, path: str, connection_id: int) -> dict:
            return {'handle': 'h', 'size': 100}

        async def read_chunk(self, handle_id, offset, length=4 * 1024 * 1024, connection_id=0):
            raise OSError('disk failure')

        async def close_read(self, handle_id: str, connection_id: int = 0) -> None:
            _ErrorAfterOpenStub.close_read_calls += 1

    stub = _ErrorAfterOpenStub()
    shim = _SyncFileStoreShim(stub)
    with pytest.raises(OSError, match='disk failure'):
        list(shim.read_chunks('any', chunk_size=4))
    assert _ErrorAfterOpenStub.close_read_calls == 1


def test_read_chunks_empty_file():
    """read_chunks on an empty file yields nothing (no bytes, no hang)."""
    inner = _AsyncInnerStub({'empty.bin': b''})
    shim = _SyncFileStoreShim(inner)
    result = b''.join(shim.read_chunks('empty.bin', chunk_size=4))
    assert result == b''
