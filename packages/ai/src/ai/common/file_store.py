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

"""Per-account FileStore builder for chat attachment byte reads.

The chat/LLM path (``ChatBase`` attachment translation) needs to turn a
FileStore path into bytes but isn't handed a FileStore by the engine, so this
builds one from the ambient ``ROCKETRIDE_CLIENT_ID``. Chat dispatch is
synchronous while the account FileStore is async, so the result is wrapped in a
shim exposing a synchronous ``read_bytes(path) -> bytes``.

(Tool nodes that accept attachments do NOT use this — they build their own
store in ``beginGlobal()``; see ``tool_filesystem`` for that pattern.)
"""

from __future__ import annotations

import asyncio
import os
from typing import Any, Generator


class _SyncFileStoreShim:
    """Wrap an async FileStore so callers get a synchronous interface.

    Exposes:
    - ``read_bytes(path) -> bytes`` — convenience read of the whole file.
    - ``stat(path) -> dict`` — file metadata including ``'size'``.
    - ``read_chunks(path, chunk_size) -> Iterator[bytes]`` — streaming read
      that never materialises the whole file; always closes the handle.
    """

    def __init__(self, inner: Any):
        self._inner = inner

    # ------------------------------------------------------------------
    # Internal sync-bridge helper
    # ------------------------------------------------------------------

    def _run(self, coro: Any) -> Any:
        """Run *coro* synchronously, raising if already inside an event loop."""
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            return asyncio.run(coro)
        raise RuntimeError('sync file-store shim cannot run inside an active event loop')

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def read_bytes(self, path: str) -> bytes:
        """Read the entire file at *path* and return raw bytes."""
        return self._run(self._inner.read(path))

    def stat(self, path: str) -> dict:
        """Return metadata dict for *path* (includes ``'size'`` in bytes)."""
        return self._run(self._inner.stat(path))

    def read_chunks(self, path: str, chunk_size: int = 2 * 1024 * 1024) -> Generator[bytes, None, None]:
        """Yield successive byte chunks of *path* without loading the whole file.

        Opens a read handle via the inner store's ``open_read`` / ``read_chunk``
        / ``close_read`` API and always closes the handle in a ``finally`` block,
        even if iteration is interrupted.

        Args:
            path: Relative path within the account store.
            chunk_size: Maximum bytes per chunk (default 2 MiB).

        Yields:
            Non-empty :class:`bytes` slices until EOF.
        """
        info = self._run(self._inner.open_read(path, 0))
        handle = info['handle']
        try:
            offset = 0
            while True:
                chunk = self._run(self._inner.read_chunk(handle, offset, chunk_size))
                if not chunk:
                    break
                yield chunk
                offset += len(chunk)
        finally:
            self._run(self._inner.close_read(handle))


def build_sync_account_file_store() -> Any:
    """Build a synchronous per-account FileStore from ``ROCKETRIDE_CLIENT_ID``.

    Resolves the account FileStore via :mod:`ai.account.store` using the
    ambient ``ROCKETRIDE_CLIENT_ID`` env var and wraps it so callers get a
    sync ``read_bytes(path) -> bytes``. Raises ``RuntimeError`` if the client
    id is unavailable (a clear error beats silently dropping the attachment).
    """
    from ai.account.store import Store

    client_id = os.environ.get('ROCKETRIDE_CLIENT_ID', '').strip()
    if not client_id:
        raise RuntimeError('ROCKETRIDE_CLIENT_ID env var is missing; cannot resolve filestore for attachments')
    async_fs = Store.create().get_file_store(client_id)
    return _SyncFileStoreShim(async_fs)
