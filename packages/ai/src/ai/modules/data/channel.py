"""
The task's side of its channel to the engine.

``task_channel`` lets code running inside a task — ``node.py`` before
``processArguments``, or a node on an engine worker thread — send a request
to the engine and get the answer, without knowing which side opened the
socket. The engine dials the task's ``/task/data``; ``DataServer`` hands the
live connection to this object, and a request waits for it when it is not
there yet.

A reply larger than one frame arrives as a stream: the engine answers with
``{size, stream}`` and the task pulls it with ``channel.read`` one chunk at
a time, so the engine's own traffic on the socket is never stuck behind a
large transfer.
"""

import asyncio
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, BinaryIO, Dict, Optional

from ai.constants import (
    CONST_CHANNEL_CHUNK,
    CONST_CHANNEL_CONNECT_TIMEOUT,
    CONST_CHANNEL_MAX_INLINE,
    CONST_CHANNEL_REQUEST_TIMEOUT,
)

if TYPE_CHECKING:
    from .data_conn import DataConn


class ChannelUnavailable(RuntimeError):
    """There is no connection to the engine, or it closed during the request."""


class ChannelError(RuntimeError):
    """The engine refused or failed the request."""

    def __init__(self, command: str, message: str) -> None:
        """Record which command failed and the engine's reason.

        Args:
            command: The command that was sent.
            message: The engine's reason, e.g. ``not allowed``, ``closed``, ``busy``.
        """
        super().__init__(f'{command}: {message}')
        self.command = command
        self.message = message


@dataclass
class ChannelReply:
    """The engine's answer.

    Attributes:
        body: The response body.
        data: The binary payload, assembled in memory; ``None`` when there was
            none or when it was written to a ``sink``.
    """

    body: Dict[str, Any]
    data: Optional[bytes] = None


class TaskChannel:
    """Request/response from the task to the engine over the live data connection."""

    def __init__(self) -> None:
        """Create an unbound channel; ``available`` stays False until ``bind``."""
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._conn: Optional['DataConn'] = None
        self._connected = asyncio.Event()
        self.available = False

    def bind(self, loop: asyncio.AbstractEventLoop) -> None:
        """Mark the channel usable and remember the loop the data server runs on.

        Args:
            loop: The loop ``DataServer`` serves on; ``request_sync`` schedules on it.
        """
        self._loop = loop
        self.available = True

    def attach(self, conn: 'DataConn') -> None:
        """Make ``conn`` the connection requests go out on.

        Args:
            conn: The connection the engine just opened.
        """
        self._conn = conn
        self._connected.set()

    def detach(self, conn: 'DataConn') -> None:
        """Forget ``conn`` if it is still the current one; a newer one stays.

        Args:
            conn: The connection that closed.
        """
        if self._conn is conn:
            self._conn = None
            self._connected.clear()

    def reset(self) -> None:
        """Return to the unbound state (tests)."""
        self._loop = None
        self._conn = None
        self._connected = asyncio.Event()
        self.available = False

    async def request(
        self,
        command: str,
        arguments: Optional[Dict[str, Any]] = None,
        *,
        data: Optional[bytes] = None,
        sink: Optional[BinaryIO] = None,
        timeout: float = CONST_CHANNEL_REQUEST_TIMEOUT,
    ) -> ChannelReply:
        """Send ``command`` to the engine and return its reply.

        Waits up to ``CONST_CHANNEL_CONNECT_TIMEOUT`` for the engine's
        connection first; that wait is not part of ``timeout``.

        Args:
            command: The command name, e.g. ``node.resolve``.
            arguments: The command's arguments.
            data: Binary payload for the request, at most one chunk.
            sink: Where a binary reply is written chunk by chunk; without it
                the reply is assembled in memory, up to ``CONST_CHANNEL_MAX_INLINE``.
            timeout: Seconds for one exchange — the request itself, and each
                chunk read separately.

        Returns:
            ChannelReply: The body and, unless written to ``sink``, the payload.

        Raises:
            ChannelUnavailable: No connection within the wait, or it closed.
            ChannelError: The engine refused or failed the command.
            ValueError: ``data`` is larger than one chunk.
        """
        if not self.available:
            raise ChannelUnavailable('this process has no data channel')
        if data is not None and len(data) > CONST_CHANNEL_CHUNK:
            raise ValueError(f'request data is larger than one chunk ({CONST_CHANNEL_CHUNK} bytes)')

        try:
            await asyncio.wait_for(self._connected.wait(), CONST_CHANNEL_CONNECT_TIMEOUT)
        except asyncio.TimeoutError:
            raise ChannelUnavailable('the engine has not connected') from None

        conn = self._conn
        if conn is None:
            raise ChannelUnavailable('the engine disconnected')

        response = await self._exchange(conn, command, arguments or {}, data, timeout)
        body = dict(response.get('body') or {})
        payload = (response.get('arguments') or {}).get('data')
        stream = body.get('stream')

        if stream is None:
            if payload is not None and sink is not None:
                sink.write(payload)
                payload = None
            return ChannelReply(body=body, data=payload)

        size = body.get('size')
        if sink is None and size is not None and size > CONST_CHANNEL_MAX_INLINE:
            raise ChannelError(command, 'too large, use sink')

        buffer = bytearray() if sink is None else None
        while True:
            chunk_response = await self._exchange(conn, 'channel.read', {'stream': stream}, None, timeout)
            chunk = (chunk_response.get('arguments') or {}).get('data') or b''
            if sink is not None:
                sink.write(chunk)
            else:
                buffer += chunk
                if len(buffer) > CONST_CHANNEL_MAX_INLINE:
                    raise ChannelError(command, 'too large, use sink')
            if (chunk_response.get('body') or {}).get('eof'):
                break

        return ChannelReply(body=body, data=bytes(buffer) if buffer is not None else None)

    def request_sync(
        self,
        command: str,
        arguments: Optional[Dict[str, Any]] = None,
        *,
        data: Optional[bytes] = None,
        sink: Optional[BinaryIO] = None,
        timeout: float = CONST_CHANNEL_REQUEST_TIMEOUT,
    ) -> ChannelReply:
        """Blocking form of ``request`` for the main thread and engine worker threads.

        Args:
            command: As for ``request``.
            arguments: As for ``request``.
            data: As for ``request``.
            sink: As for ``request``.
            timeout: As for ``request``.

        Returns:
            ChannelReply: As for ``request``.

        Raises:
            RuntimeError: Called on the data server's own loop thread, where
                blocking on it would deadlock.
            ChannelUnavailable: As for ``request``.
            ChannelError: As for ``request``.
        """
        if not self.available or self._loop is None:
            raise ChannelUnavailable('this process has no data channel')
        if asyncio._get_running_loop() is self._loop:
            raise RuntimeError('request_sync on the data server loop would deadlock; await request() instead')

        future = asyncio.run_coroutine_threadsafe(
            self.request(command, arguments, data=data, sink=sink, timeout=timeout), self._loop
        )
        return future.result()

    async def _exchange(
        self,
        conn: 'DataConn',
        command: str,
        arguments: Dict[str, Any],
        data: Optional[bytes],
        timeout: float,
    ) -> Dict[str, Any]:
        """Send one request on ``conn`` and map failures to the channel exceptions.

        Args:
            conn: The connection to send on.
            command: The command name.
            arguments: The command's arguments.
            data: Binary payload, or ``None``.
            timeout: Seconds to wait for the response.

        Returns:
            dict: The successful response message.

        Raises:
            ChannelUnavailable: The connection closed or the send failed.
            ChannelError: Timeout, or the engine answered with an error.
        """
        try:
            response = await conn.send_request(command, arguments, data=data, timeout=timeout)
        except asyncio.TimeoutError:
            raise ChannelError(command, 'timeout') from None
        except ConnectionError as e:
            raise ChannelUnavailable(str(e)) from None

        if not response.get('success', False):
            raise ChannelError(command, response.get('message') or 'refused')
        return response


# The one channel of this process; see the module docstring
task_channel = TaskChannel()
