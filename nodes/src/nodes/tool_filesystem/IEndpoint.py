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
as raw objects. The configured ``path`` (relative to ``users/<client_id>/files/``)
may be a single file or a folder; with ``recursive`` on, subfolders are
descended as well.

Delivery uses the engine's target-pipe push contract (the same sequence the
telegram source uses): per file, ``target.getPipe()`` -> ``pipe.open(entry)``
-> ``writeTagBeginObject/BeginStream`` -> ``writeTagData(bytes)`` ->
``EndStream/EndObject`` -> ``pipe.close()``. The raw bytes ride the ``tags``
lane to a downstream Parser. The task completes when ``scanObjects`` returns —
this is a finite source, not a long-running server.
"""

from __future__ import annotations

import asyncio
import mimetypes
import os
from typing import Any, Callable, Dict

from ai.account.store import Store
from rocketlib import IEndpointBase, getObject, monitorCompleted, monitorFailed, warning


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
    while folders:
        folder = folders.pop(0)
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

    target = None

    def _params(self) -> Dict[str, Any]:
        try:
            return self.endpoint.serviceConfig['parameters'] or {}
        except Exception:
            return {}

    def validateConfig(self, syntaxOnly: bool) -> None:
        if not str(self._params().get('path') or '').strip():
            raise ValueError('File Store Source: "path" is required')

    def scanObjects(self, path: str, scanCallback: Callable[[Dict[str, Any]], None]) -> None:
        """Enumerate the configured path and push each file into the pipeline.

        The engine's scan callback is not used: content is pushed through the
        target pipe directly (telegram pattern), so enumeration and delivery
        happen in one pass and the task completes on return.
        """
        params = self._params()
        rel = str(params.get('path') or '').strip().strip('/')
        recursive = bool(params.get('recursive', False))

        client_id = os.environ.get('ROCKETRIDE_CLIENT_ID', '').strip()
        if not client_id:
            raise ValueError(
                'File Store Source: ROCKETRIDE_CLIENT_ID env var is missing; this source must run inside the task engine'
            )
        store = Store.create().get_file_store(client_id)
        self.target = self.endpoint.target

        for file_path, size in asyncio.run(_collect(store, rel, recursive)):
            self._push_file(store, file_path, size)

    def _push_file(self, store, file_path: str, size: int) -> None:
        """Read one file and stream it through a target pipe as a raw object."""
        try:
            data = asyncio.run(store.read(file_path))
        except Exception as e:
            monitorFailed(size)
            warning(f'File Store Source: failed to read {file_path!r}: {e}')
            return

        mime = mimetypes.guess_type(file_path)[0] or 'application/octet-stream'
        entry = getObject(
            obj={
                'url': f'filestore://{file_path}',
                'name': file_path,
                'size': len(data),
                'mimeType': mime,
            }
        )
        pipe = self.target.getPipe()
        try:
            pipe.open(entry)
            pipe.writeTagBeginObject()
            pipe.writeTagBeginStream()
            pipe.writeTagData(data)
            pipe.writeTagEndStream()
            pipe.writeTagEndObject()
            pipe.close()
            monitorCompleted(len(data))
        except Exception as e:
            monitorFailed(len(data))
            warning(f'File Store Source: failed to push {file_path!r}: {e}')
        finally:
            self.target.putPipe(pipe)
