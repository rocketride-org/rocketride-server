# MIT License
#
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in all
# copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.

"""A producing node's bytes, readable before it finishes.

Nodes are separate processes: the spool file is the channel. A read past the end
waits, so empty bytes only ever mean end-of-stream — declared by ``.done``.
"""

import asyncio
import hashlib
import json
import os
import tempfile
from typing import Optional

READ_TIMEOUT = 30.0
POLL_INTERVAL = 0.02


def live_dir() -> str:
    """Directory holding in-flight artifact spools, created on first use."""
    path = os.environ.get('ROCKETRIDE_LIVE_MEDIA_DIR') or os.path.join(tempfile.gettempdir(), 'rocketride-live-media')
    os.makedirs(path, mode=0o700, exist_ok=True)  # spools may hold private media in a shared tmp
    return path


def _key(client_id: str, path: str) -> str:
    """Stable spool name; both processes derive it independently."""
    digest = hashlib.sha256(f'{client_id}\0{path}'.encode()).hexdigest()
    return digest[:32]


def spool_paths(client_id: str, path: str) -> tuple[str, str]:
    """The ``(.part, .done)`` pair backing an artifact."""
    base = os.path.join(live_dir(), _key(client_id, path))
    return f'{base}.part', f'{base}.done'


def is_live(client_id: str, path: str) -> bool:
    """True while a spool exists — the artifact is streaming or just finished.

    On Windows a reader can hold a ``.part`` open past the producer's ``discard()``, so a
    stale spool would shadow the finished artifact forever (every open takes the live branch
    and times out). A successful unlink there means nobody holds it — it was stale, not live.
    POSIX allows unlinking an open file, so we never risk pulling the rug from a live stream
    there; ``discard()`` already succeeds and leaves no ``.part`` behind.
    """
    part, _ = spool_paths(client_id, path)
    if not os.path.exists(part):
        return False
    if os.name == 'nt':
        try:
            os.unlink(part)
            return False
        except OSError:
            return True
    return True


class LiveWriter:
    """Node-side half: append bytes, then declare the stream finished."""

    def __init__(self, client_id: str, path: str):
        self._part, self._done = spool_paths(client_id, path)
        self._fh = None
        self._written = 0

    def begin(self) -> None:
        """Open the spool, discarding any stale one for this artifact."""
        for p in (self._part, self._done):
            try:
                os.unlink(p)
            except FileNotFoundError:
                pass
        self._fh = open(self._part, 'wb')
        self._written = 0

    def append(self, data: bytes) -> None:
        """Append a chunk and flush it, so a reader in another process sees it."""
        if self._fh is None:
            raise RuntimeError('LiveWriter.append before begin')
        self._fh.write(data)
        self._fh.flush()
        self._written += len(data)

    def finish(self) -> int:
        """Close the spool, then publish the final size.
        The sidecar goes last, so a reader that sees it finds every byte on disk.
        """
        if self._fh is not None:
            self._fh.flush()
            os.fsync(self._fh.fileno())
            self._fh.close()
            self._fh = None
        with open(self._done, 'w') as fh:
            json.dump({'size': self._written}, fh)
        return self._written

    def discard(self) -> None:
        """Drop the spool. Best-effort: Windows will not unlink one a reader holds open."""
        if self._fh is not None:
            self._fh.close()
            self._fh = None
        for p in (self._part, self._done):
            try:
                os.unlink(p)
            except OSError:
                pass


class LiveReader:
    """Server-side half: read the spool, waiting for bytes the node has not written yet."""

    def __init__(self, client_id: str, path: str):
        self._part, self._done = spool_paths(client_id, path)
        self._fh = None

    def open(self) -> None:
        """Open the spool for reading. Raises FileNotFoundError if it is gone."""
        self._fh = open(self._part, 'rb')

    def close(self) -> None:
        if self._fh is not None:
            self._fh.close()
            self._fh = None

    def final_size(self) -> Optional[int]:
        """Total length once known, else None while the stream still grows."""
        try:
            with open(self._done) as fh:
                return int(json.load(fh)['size'])
        except (FileNotFoundError, KeyError, ValueError):
            pass
        # discard() removes the sidecar too, so a reader that outlives the reclaim
        # would never see its end. A missing spool means the producer finished.
        return self._reclaimed_size()

    def available(self) -> int:
        """Bytes on disk. A reclaimed spool is still readable through our descriptor."""
        try:
            return os.path.getsize(self._part)
        except FileNotFoundError:
            return self._reclaimed_size() or 0

    def _reclaimed_size(self) -> Optional[int]:
        """The size our open descriptor still sees, once the spool file is gone."""
        if self._fh is None or os.path.exists(self._part):
            return None
        return os.fstat(self._fh.fileno()).st_size

    def complete(self) -> bool:
        return self.final_size() is not None

    async def read(self, offset: int, length: int, timeout: float = READ_TIMEOUT) -> bytes:
        """Read at ``offset``, waiting for the producer. Empty bytes mean end-of-stream.
        Raises TimeoutError so a stalled node cannot hang the connection with it.
        """
        if self._fh is None:
            raise RuntimeError('LiveReader.read before open')

        deadline = asyncio.get_running_loop().time() + timeout
        while True:
            # available before final_size: finish() writes bytes first, sidecar last,
            # so this order can never miss the trailing chunk.
            available = self.available()
            if offset < available:
                self._fh.seek(offset)
                return self._fh.read(min(length, available - offset))

            final = self.final_size()
            if final is not None and offset >= final:
                return b''

            if asyncio.get_running_loop().time() >= deadline:
                raise TimeoutError(f'live media stalled at offset {offset} (available {available})')
            await asyncio.sleep(POLL_INTERVAL)
