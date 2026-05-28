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

"""Shared per-account FileStore builder for attachment byte reads.

Both the chat/LLM path (``ChatBase`` attachment translation) and tool-node
attachment resolution need to turn a FileStore path into bytes, and neither is
handed a FileStore by the engine today. This module centralizes the fallback
that constructs one from the ambient ``ROCKETRIDE_CLIENT_ID`` so the two paths
cannot drift. The returned object exposes a synchronous
``read_bytes(path) -> bytes``.
"""

from __future__ import annotations

import asyncio
import os
from typing import Any


class _SyncFileStoreShim:
    """Wrap an async FileStore so callers get a synchronous ``read_bytes``."""

    def __init__(self, inner: Any):
        self._inner = inner

    def read_bytes(self, path: str) -> bytes:
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            return asyncio.run(self._inner.read(path))
        raise RuntimeError('attachment read cannot run inside an active event loop')


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
