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

"""
File Store source endpoint.

Streams files from the account-scoped RocketRide file store into the pipeline
as raw objects. The configured ``path`` (relative to the task's storage anchor)
may be a single file or a folder; with ``recursive`` on, subfolders are
descended as well.

Delivery uses the engine's DIRECT pipeline mode contract (see
``engine-lib/task/pipe/Pipeline.cpp``: "Connect the scanObjects function to the
renderObject function"): ``scanObjects`` enumerates the configured path and
reports each file through the engine's scan callback, which feeds the scanner's
object counter and queues the entry for processing. The engine then opens each
entry on the target pipe and calls ``renderObject`` on the node instance
(``IInstance.renderObject`` delegates to :meth:`IEndpoint.renderStoreObject`),
which reads the file and sends the raw bytes as a tag stream down the ``tags``
lane to a downstream Parser. Completed/failed accounting is done by the engine
per rendered entry. The task completes when the scan queue drains — this is a
finite source, not a long-running server.
"""

from __future__ import annotations

import asyncio
from typing import Any, Callable, Dict

from ai.account.store import Store
from rocketlib import IEndpointBase


# Upper bound on folders visited by one recursive scan. Backends that surface
# symlinked directories can otherwise present an endless tree of distinct paths.
_MAX_SCAN_FOLDERS = 10_000


async def _collect(store, rel: str, recursive: bool) -> list[tuple[str, int]]:
    """Resolve ``rel`` to a sorted list of ``(path, size)`` files to process.

    A file path yields itself; a folder yields its files (breadth-first into
    subfolders when ``recursive``). Raises if the path does not exist.
    """
    st = await store.stat(rel)
    if not st.get('exists'):
        raise ValueError(f'File Store Source: path {rel!r} does not exist in the account file store')
    if st.get('type') == 'file':
        return [(rel, int(st.get('size', 0)))]

    out: list[tuple[str, int]] = []
    folders = [rel]
    walked = 0
    while folders:
        folder = folders.pop(0)
        walked += 1
        if walked > _MAX_SCAN_FOLDERS:
            # A backend that reports symlinked directories can present an
            # unbounded tree of distinct paths — fail the scan loudly instead
            # of hanging it.
            raise ValueError(
                f'File Store Source: scan exceeded {_MAX_SCAN_FOLDERS} folders under {rel!r}; '
                'aborting (possible directory cycle in the store backend)'
            )
        listing = await store.list_dir(folder)
        for entry in listing.get('entries', []):
            child = f'{folder}/{entry["name"]}' if folder else entry['name']
            if entry.get('type') == 'dir':
                if recursive:
                    folders.append(child)
            else:
                out.append((child, int(entry.get('size', 0))))
    return sorted(out)


class IEndpoint(IEndpointBase):
    """Finite source endpoint over the account FileStore."""

    def _params(self) -> Dict[str, Any]:
        try:
            return self.endpoint.serviceConfig['parameters'] or {}
        except Exception:
            return {}

    @staticmethod
    def _store():
        """Build the FileStore anchored at the current engine task's storage root.

        Identity and the storage anchor come from the task file the engine
        published (``rocketlib.getTask()``) — never from the environment —
        so paths behave identically in development and deployed runs (same
        contract as the tool/sink variants' ``IGlobal``).
        """
        store = Store.engine_file_store()
        if store is None:
            raise ValueError(
                'File Store Source: no running task with an identity (rocketlib.getTask); this source must run inside the task engine'
            )
        return store

    def validateConfig(self, syntaxOnly: bool) -> None:
        if not str(self._params().get('path') or '').strip():
            raise ValueError('File Store Source: "path" is required')

    def scanObjects(self, path: str, scanCallback: Callable[[Dict[str, Any]], int]) -> None:
        """Enumerate the configured path and report each file to the engine.

        Each file is passed to ``scanCallback`` as an object entry; the engine
        queues it and delivers the content via ``renderObject`` (see
        :meth:`renderStoreObject`). Reporting through the callback also feeds
        the scanner's object counter, so a successful run does not end with a
        spurious "Files not found" warning.
        """
        params = self._params()
        rel = str(params.get('path') or '').strip().strip('/')
        if not rel:
            raise ValueError('File Store Source: "path" is required')
        recursive = bool(params.get('recursive', False))

        store = self._store()
        for file_path, size in asyncio.run(_collect(store, rel, recursive)):
            # A non-zero return means the engine wants the scan stopped
            # (cancellation or license limit reached).
            if scanCallback({'name': file_path, 'size': size}):
                break

    def renderStoreObject(self, entry, instance) -> None:
        """Render one scanned entry: read the file and send it as a raw tag stream.

        Called by ``IInstance.renderObject`` with the engine ``instance`` whose
        ``sendTag*`` functions write into the already-open target pipe. Errors
        propagate so the engine marks the entry failed and counts it.

        Ends with an explicit ``sendClose``: task-mode ``processItem`` closes
        the object pipe itself, but the dev-mode runner leaves closure to the
        source — without it the ``close`` lifecycle lane never dispatches and
        every object shows PROCESSING forever in the run trace. The engine's
        own close is a no-op on an already-closed pipe, so both modes are
        safe. Same contract the telegram/webhook push sources follow.
        """
        file_path = str(entry.name).strip('/')
        data = asyncio.run(self._store().read(file_path))
        instance.sendTagBeginObject()
        instance.sendTagBeginStream()
        instance.sendTagData(data)
        instance.sendTagEndStream()
        instance.sendTagEndObject()
        instance.sendClose()
