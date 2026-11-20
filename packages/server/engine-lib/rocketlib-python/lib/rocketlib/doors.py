# =============================================================================
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
A node's two storage doors: ``self.state`` and ``self.files`` (plan 5.7).

The IGlobal holds caches, never state: the balancer sends one control's calls
to different replicas and the idle sweep forgets a control's globals, so
anything whose loss changes an answer (a rolling window, a session, a counter)
lives behind one of these doors instead.

Both are clients of the SERVER. A request carries the binding it is made from
(the server-minted ``correlationId`` of the request, which the instance froze
with its caller when the engine bound it) plus the node's own key or path, and
nothing else: the server finds the control that owns the binding and decides
from its own record whose rows and whose files those are; a binding that has
ended reaches nothing. No identity crosses the process boundary in
the request direction, so a node that rewrites what it believes about its
caller mislabels its own logs and reaches nobody else's data.

- ``NodeState``: small JSON values (``get``/``put``/``delete``/``incr``, and
  ``with state.lock(key):`` around a read-modify-write). The node names only
  its own part of the key; the server escapes it and prefixes it with the
  owner (org, owner, address). Values are capped and expire with the
  control's idle policy unless a ``ttl`` says otherwise.
- ``NodeFiles``: the account file store rooted at the owner's tree (the
  task's team subtree on the deploy rail), with the operations clients get
  from ``rrext_store``; ``get_url`` defaults to a short expiry.

The transport is installed by the process hosting the engine (the data
server binds the per-run data channel with ``setNodeChannel``); outside the
task engine there is none and every request raises ``DoorError``.
"""

from __future__ import annotations

import time
from contextlib import contextmanager
from typing import Any, Callable, Dict, Iterator, Optional, Tuple

# ==== Constants ==============================================================

#: Seconds ``NodeState.lock`` waits for a key another binding holds.
STATE_LOCK_TIMEOUT = 10.0

#: Seconds the server keeps a lock whose holder never released it (a crash).
STATE_LOCK_LEASE = 30.0

#: First and longest pause between two attempts at a held lock.
STATE_LOCK_BACKOFF = (0.02, 0.25)

#: Seconds a ``NodeFiles.get_url`` link lives when the node names no expiry.
FILES_URL_EXPIRES_IN = 300

#: Bytes a whole-file ``NodeFiles.read`` returns at most unless the node names
#: another limit (the account FileStore's own ``read`` default).
FILES_READ_MAX_SIZE = 100 * 1024 * 1024

# ==== The channel ============================================================


class DoorError(RuntimeError):
    """The server refused a state or files request, or this process has no channel to send it on."""


#: ``(command, arguments, data) -> (body, data)``: one request over the data channel.
ChannelRequest = Callable[[str, Dict[str, Any], Optional[bytes]], Tuple[Dict[str, Any], Optional[bytes]]]

_channel: Optional[ChannelRequest] = None

#: The largest payload one request may carry; set with the channel.
_chunk = 1024 * 1024


def setNodeChannel(request: Optional[ChannelRequest], chunk: int = 1024 * 1024) -> None:
    """
    Install the transport ``self.state`` and ``self.files`` send over.

    Called once by the process that hosts the engine (the task's data server),
    with a blocking request over its data channel. None removes it.

    Args:
        request: ``(command, arguments, data) -> (body, data)``; raises on a
            refusal with the server's reason.
        chunk: The largest binary payload one request carries.
    """
    global _channel, _chunk
    _channel = request
    _chunk = max(1, int(chunk))


def _send(command: str, arguments: Dict[str, Any], data: Optional[bytes] = None) -> Tuple[Dict[str, Any], Any]:
    """
    Send one request and return the server's answer.

    Args:
        command: The channel command (``state.get``, ``fs_open``, ...).
        arguments: Its arguments; the binding is already among them.
        data: A binary payload of at most one chunk.

    Returns:
        ``(body, data)`` as the server answered.

    Raises:
        DoorError: No channel in this process, or the server refused.
    """
    channel = _channel
    if channel is None:
        raise DoorError(
            f'{command}: this process has no data channel; self.state and self.files work inside the task engine'
        )
    try:
        return channel(command, arguments, data)
    except DoorError:
        raise
    except Exception as e:
        raise DoorError(str(e)) from None


# ==== self.state =============================================================


class NodeState:
    """
    ``self.state``: small JSON values that survive a call, owned by the binding's control (plan 5.7).

    Every request names this door's binding; the server turns the node's key
    into the physical one. Read-modify-write goes inside ``lock``::

        with self.state.lock(key):
            window = self.state.get(key) or []
            window.append(value)
            self.state.put(key, window[-100:])
    """

    def __init__(self, binding: str):
        """
        Bind the door to one binding.

        Args:
            binding: The binding's ``correlationId`` from its frozen caller
                (empty for engine-level work, which the server answers only on
                an engine one control holds).
        """
        self._binding = str(binding or '')
        # key -> the token of the lease ``lock`` holds on it: a write to a held
        # key names it, and the server refuses the write once the lease lapsed
        self._held: Dict[str, str] = {}

    def _args(self, key: str, **extra: Any) -> Dict[str, Any]:
        """The arguments of one request: the binding, the node's key, the rest."""
        if not isinstance(key, str) or not key:
            raise DoorError('a state key is a non-empty string')
        return {'correlationId': self._binding, 'key': key, **extra}

    def _write_args(self, key: str, **extra: Any) -> Dict[str, Any]:
        """The arguments of a write: a held key's write is fenced by its lock's token."""
        arguments = self._args(key, **extra)
        token = self._held.get(key)
        if token is not None:
            arguments['token'] = token
        return arguments

    def get(self, key: str, default: Any = None) -> Any:
        """
        Return the value stored under ``key``.

        Args:
            key: The node's key.
            default: What an absent (or expired) key returns.

        Returns:
            A fresh copy of the stored JSON value, or ``default``.
        """
        body, _ = _send('state.get', self._args(key))
        return body.get('value') if body.get('found') else default

    def put(self, key: str, value: Any, ttl: Optional[float] = None) -> None:
        """
        Store a JSON value under ``key``.

        Args:
            key: The node's key.
            value: Any JSON value (capped by the server).
            ttl: Seconds until it expires; None follows the control's idle policy.
        """
        _send('state.put', self._write_args(key, value=value, ttl=ttl))

    def delete(self, key: str) -> bool:
        """
        Remove ``key``.

        Returns:
            True when a value was there.
        """
        body, _ = _send('state.delete', self._write_args(key))
        return bool(body.get('deleted'))

    def incr(self, key: str, amount: int = 1, ttl: Optional[float] = None) -> int:
        """
        Add ``amount`` to the integer under ``key`` (an absent key counts from 0), atomically.

        Args:
            key: The node's key.
            amount: The increment (negative to decrement).
            ttl: Seconds until it expires; None follows the control's idle policy.

        Returns:
            The new value.
        """
        body, _ = _send('state.incr', self._write_args(key, amount=int(amount), ttl=ttl))
        return int(body.get('value', 0))

    @contextmanager
    def lock(self, key: str, timeout: float = STATE_LOCK_TIMEOUT) -> Iterator[None]:
        """
        Hold ``key`` for a read-modify-write: every binding of the owner that locks it waits its turn.

        The server never blocks on a held lock (a waiting request would hold
        a channel slot the holder needs to release it); this side retries
        with backoff until ``timeout``. A holder that dies loses the lock
        after ``STATE_LOCK_LEASE`` seconds; ``put``/``delete``/``incr`` of the
        key inside the block are fenced by the lease, so a holder that
        outlived it gets a ``DoorError`` instead of overwriting the next
        holder's work.

        Args:
            key: The node's key.
            timeout: Seconds to wait for a key another binding holds.

        Raises:
            DoorError: The key stayed held for ``timeout`` seconds.
        """
        deadline = time.monotonic() + timeout
        pause, longest = STATE_LOCK_BACKOFF
        token = None
        while token is None:
            body, _ = _send('state.lock', self._args(key, lease=STATE_LOCK_LEASE))
            if body.get('acquired'):
                token = body.get('token')
                break
            if time.monotonic() + pause > deadline:
                raise DoorError(f'state.lock: "{key}" is held by another binding; gave up after {timeout} seconds')
            time.sleep(pause)
            pause = min(pause * 2, longest)
        self._held[key] = token
        try:
            yield
        finally:
            self._held.pop(key, None)
            _send('state.unlock', self._args(key, token=token))


# ==== self.files =============================================================


class NodeFiles:
    """
    ``self.files``: the file store rooted at the binding's owner's tree (plan 5.7).

    Plain relative paths only: the server builds the store for the control
    that owns the binding (the owner's tree on the dev rail, the task's team
    subtree on the deploy rail) and refuses every scoped (``@``) path.
    """

    def __init__(self, binding: str):
        """
        Bind the door to one binding.

        Args:
            binding: The binding's ``correlationId`` from its frozen caller
                (empty for engine-level work, which the server answers only on
                an engine one control holds).
        """
        self._binding = str(binding or '')

    def _call(self, command: str, data: Optional[bytes] = None, **arguments: Any) -> Tuple[Dict[str, Any], Any]:
        """One request carrying this door's binding."""
        return _send(command, {'correlationId': self._binding, **arguments}, data)

    # ---- Whole files -----------------------------------------------------

    def read(self, path: str, max_size: int = FILES_READ_MAX_SIZE) -> bytes:
        """
        Return a file's bytes.

        Args:
            path: The file, relative to the owner's tree.
            max_size: Refuse a file larger than this many bytes (default
                ``FILES_READ_MAX_SIZE``); checked on the size the server
                reports and again on the bytes received, so a file that grows
                while it is read is refused too.

        Raises:
            DoorError: Missing, refused, or larger than ``max_size``.
        """
        body, _ = self._call('fs_open', path=path, mode='r')
        handle, size = body.get('handle'), int(body.get('size') or 0)
        try:
            if size > max_size:
                raise DoorError(f'{path} is {size} bytes, more than the {max_size} allowed')
            chunks, offset = [], 0
            while True:
                _, chunk = self._call('fs_read', handle=handle, offset=offset, length=_chunk)
                if not chunk:
                    break
                offset += len(chunk)
                if offset > max_size:
                    raise DoorError(f'{path} is more than the {max_size} bytes allowed')
                chunks.append(bytes(chunk))
            return b''.join(chunks)
        finally:
            self._call('fs_close', handle=handle, mode='r')

    def write(self, path: str, data: bytes) -> None:
        """
        Write a file, replacing it.

        Args:
            path: The file, relative to the owner's tree.
            data: Its bytes.
        """
        handle = self.open_write(path)
        try:
            view = memoryview(bytes(data))
            for start in range(0, len(view), _chunk):
                self.write_chunk(handle, view[start : start + _chunk].tobytes())
        finally:
            self.close_write(handle)

    def put_json(self, path: str, value: Any) -> int:
        """
        Write a JSON document in one request.

        Returns:
            The bytes written.
        """
        body, _ = self._call('fs_put_json', path=path, value=value)
        return int(body.get('bytesWritten', 0))

    def get_json(self, path: str) -> Any:
        """Return a JSON document read in one request."""
        body, _ = self._call('fs_get_json', path=path)
        return body.get('value')

    # ---- Streaming writes --------------------------------------------------

    def open_write(self, path: str) -> str:
        """
        Open a file for writing in pieces.

        Returns:
            The handle ``write_chunk`` and ``close_write`` take.
        """
        body, _ = self._call('fs_open', path=path, mode='w')
        return str(body.get('handle'))

    def write_chunk(self, handle: str, data: bytes) -> int:
        """
        Append bytes to an open file.

        Returns:
            The bytes written.
        """
        written = 0
        view = memoryview(bytes(data))
        for start in range(0, len(view), _chunk) if len(view) else (0,):
            body, _ = self._call('fs_write', view[start : start + _chunk].tobytes(), handle=handle)
            written += int(body.get('bytesWritten', 0))
        return written

    def close_write(self, handle: str) -> None:
        """Commit and close a file opened with ``open_write``."""
        self._call('fs_close', handle=handle, mode='w')

    # ---- The tree ----------------------------------------------------------

    def delete(self, path: str) -> None:
        """Delete a file."""
        self._call('fs_delete', path=path)

    def list_dir(self, path: str = '') -> Dict[str, Any]:
        """
        List a folder.

        Returns:
            ``{'entries': [{'name', 'type', 'size', ...}], 'count'}``.
        """
        body, _ = self._call('fs_list_dir', path=path)
        return body

    def mkdir(self, path: str) -> None:
        """Create a folder."""
        self._call('fs_mkdir', path=path)

    def stat(self, path: str) -> Dict[str, Any]:
        """
        Describe a path.

        Returns:
            ``{'exists', 'type', 'size', ...}``; ``exists`` False for a missing path.
        """
        body, _ = self._call('fs_stat', path=path)
        return body

    def rename(self, old_path: str, new_path: str, overwrite: bool = False) -> None:
        """Move a file or folder; ``overwrite`` replaces an existing target."""
        self._call('fs_rename', old_path=old_path, new_path=new_path, overwrite=bool(overwrite))

    def get_url(self, path: str, expires_in: Optional[int] = None, download_name: Optional[str] = None) -> str:
        """
        Return a link that fetches the file without a session.

        Args:
            path: The file.
            expires_in: Seconds the link lives (default ``FILES_URL_EXPIRES_IN``).
            download_name: The file name a browser saves it as.
        """
        body, _ = self._call(
            'fs_geturl',
            path=path,
            expires_in=int(expires_in if expires_in is not None else FILES_URL_EXPIRES_IN),
            download_name=download_name,
        )
        return str(body.get('url') or '')
