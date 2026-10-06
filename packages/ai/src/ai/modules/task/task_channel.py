"""
Commands a task may ask the engine over its data channel.

The engine answers a task's request only when the command is registered
here, with ``register_channel_command``. Anything else is refused and
logged; the dispatch never looks commands up by attribute name, so a task
cannot reach a method of the connection object by naming it.

A command has a phase: ``startup`` commands are answered only until the
task reports that it is about to load its pipeline (``>CHN*2``); ``run``
commands for the whole run. Node delivery is ``startup`` — once the
pipeline's own code runs, no more code enters the task.

A handler may return bytes, a file path or an async iterator of bytes. A
payload larger than one chunk is not sent at once: the reply names a
stream and the task pulls it with the built-in ``channel.read``, one chunk
per round trip, so the engine's own requests on the socket interleave.
"""

import asyncio
import os
import time
import uuid
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, AsyncIterator, Awaitable, Callable, Dict, Optional, Tuple, Union

from rocketlib import debug

from ai.constants import CONST_CHANNEL_CHUNK, CONST_CHANNEL_HANDLER_TIMEOUT, CONST_CHANNEL_STREAM_IDLE

if TYPE_CHECKING:
    from ai.common.dap import DAPBase

    from .task_engine import Task

PHASE_STARTUP = 'startup'
PHASE_RUN = 'run'

CONST_CHANNEL_READ = 'channel.read'

Source = Union[bytes, bytearray, str, 'os.PathLike[str]', AsyncIterator[bytes], None]


class ChannelRefused(Exception):
    """A handler's refusal whose message is returned to the task, e.g. ``forbidden``."""


@dataclass
class ChannelReply:
    """What a handler returns.

    Attributes:
        body: The response body.
        data: Binary payload — bytes, a file path, or an async iterator of
            bytes; ``None`` for none.
    """

    body: Optional[Dict[str, Any]] = None
    data: Source = None


Handler = Callable[['Task', Dict[str, Any], Optional[bytes]], Awaitable[ChannelReply]]


@dataclass
class _Command:
    """A registered command."""

    handler: Handler
    phase: str


_commands: Dict[str, _Command] = {}


def register_channel_command(name: str, handler: Handler, phase: str = PHASE_RUN) -> None:
    """Allow a task to ask ``name`` and route it to ``handler``.

    Args:
        name: The command, e.g. ``node.resolve``.
        handler: ``async (task, arguments, data) -> ChannelReply``; ``task`` is the
            caller, taken from the connection, never from the request.
        phase: ``startup`` or ``run``.

    Raises:
        ValueError: Unknown phase, or the built-in ``channel.read`` name.
    """
    if phase not in (PHASE_STARTUP, PHASE_RUN):
        raise ValueError(f'unknown phase {phase!r}')
    if name == CONST_CHANNEL_READ:
        raise ValueError(f'{name} is built in')
    _commands[name] = _Command(handler=handler, phase=phase)


def unregister_channel_command(name: str) -> None:
    """Forget ``name``; no error when it is not registered.

    Args:
        name: The command.
    """
    _commands.pop(name, None)


class ChannelStreams:
    """Replies one connection is pulling in chunks.

    A stream lives until it is read to the end, the connection closes, or
    it sits unread for ``CONST_CHANNEL_STREAM_IDLE``.
    """

    def __init__(self) -> None:
        """Start with no streams."""
        self._streams: Dict[str, Tuple[AsyncIterator[bytes], bytearray, float]] = {}

    def open(self, source: Source) -> str:
        """Register ``source`` and return the id the task reads it by.

        Args:
            source: Bytes, a file path, or an async iterator of bytes.

        Returns:
            str: The stream id.
        """
        stream_id = uuid.uuid4().hex
        self._streams[stream_id] = (_iterate(source), bytearray(), time.monotonic())
        return stream_id

    async def read(self, stream_id: str) -> Tuple[bytes, bool]:
        """Return the next chunk of ``stream_id`` and whether it was the last.

        Args:
            stream_id: The id from ``open``.

        Returns:
            tuple: ``(chunk, eof)``; the stream is gone once ``eof`` is True.

        Raises:
            KeyError: Unknown, expired or finished stream.
        """
        self._expire()
        iterator, buffer, _ = self._streams[stream_id]

        exhausted = False
        while len(buffer) < CONST_CHANNEL_CHUNK:
            try:
                buffer += await iterator.__anext__()
            except StopAsyncIteration:
                exhausted = True
                break

        chunk = bytes(buffer[:CONST_CHANNEL_CHUNK])
        del buffer[:CONST_CHANNEL_CHUNK]
        eof = exhausted and not buffer
        if eof:
            del self._streams[stream_id]
        else:
            self._streams[stream_id] = (iterator, buffer, time.monotonic())
        return chunk, eof

    def close_all(self) -> None:
        """Drop every stream; the task's reads will be refused."""
        self._streams.clear()

    def _expire(self) -> None:
        """Drop streams nobody has read for ``CONST_CHANNEL_STREAM_IDLE``."""
        deadline = time.monotonic() - CONST_CHANNEL_STREAM_IDLE
        for stream_id in [s for s, (_, _, used) in self._streams.items() if used < deadline]:
            del self._streams[stream_id]


async def _iterate(source: Source) -> AsyncIterator[bytes]:
    """Yield ``source`` as pieces of bytes, reading a file off the loop thread.

    Args:
        source: Bytes, a file path, or an async iterator of bytes.

    Yields:
        bytes: Pieces of any size; the stream re-slices them to chunks.
    """
    if isinstance(source, (bytes, bytearray)):
        yield bytes(source)
        return
    if isinstance(source, (str, os.PathLike)):
        with open(source, 'rb') as handle:
            while piece := await asyncio.to_thread(handle.read, CONST_CHANNEL_CHUNK):
                yield piece
        return
    async for piece in source:
        yield piece


def _size_of(source: Source) -> Optional[int]:
    """Return the payload size when it is known up front.

    Args:
        source: Bytes, a file path, or an async iterator of bytes.

    Returns:
        int or None: The size; ``None`` for an iterator.
    """
    if isinstance(source, (bytes, bytearray)):
        return len(source)
    if isinstance(source, (str, os.PathLike)):
        return os.path.getsize(source)
    return None


async def handle(
    task: 'Task', client: 'DAPBase', streams: ChannelStreams, message: Dict[str, Any], *, startup_open: bool
) -> Dict[str, Any]:
    """Answer one request from a task.

    Args:
        task: The task whose connection carried the request.
        client: The engine's connection object; builds the response envelope.
        streams: The connection's streams, for ``channel.read`` and chunked replies.
        message: The DAP request.
        startup_open: Whether ``startup`` commands are still allowed.

    Returns:
        dict: The DAP response to send back.
    """
    command = message.get('command', '')
    arguments = dict(message.get('arguments') or {})
    data = arguments.pop('data', None)

    if command == CONST_CHANNEL_READ:
        try:
            chunk, eof = await streams.read(str(arguments.get('stream')))
        except KeyError:
            return client.build_error(message, 'unknown stream')
        response = client.build_response(message, body={'eof': eof})
        response['arguments'] = {'data': chunk}
        return response

    registered = _commands.get(command)
    if registered is None:
        debug(f'Task {task.id} asked {command!r}, which is not a channel command')
        return client.build_error(message, 'command not allowed')
    if registered.phase == PHASE_STARTUP and not startup_open:
        return client.build_error(message, 'closed')

    try:
        reply = await asyncio.wait_for(registered.handler(task, arguments, data), CONST_CHANNEL_HANDLER_TIMEOUT)
    except asyncio.TimeoutError:
        return client.build_error(message, 'timeout')
    except ChannelRefused as e:
        return client.build_error(message, str(e))
    except asyncio.CancelledError:
        raise
    except Exception as e:
        # The task is not trusted with the engine's internals
        debug(f'Task {task.id}: channel command {command!r} failed: {e!r}')
        return client.build_error(message, 'internal error')

    body = dict(reply.body or {})
    source = reply.data
    if source is None:
        return client.build_response(message, body=body)

    size = _size_of(source)
    if size is not None and size <= CONST_CHANNEL_CHUNK:
        response = client.build_response(message, body=body)
        response['arguments'] = {
            'data': bytes(source) if isinstance(source, (bytes, bytearray)) else _read_file(source)
        }
        return response

    body['stream'] = streams.open(source)
    body['size'] = size
    return client.build_response(message, body=body)


def _read_file(path: Union[str, 'os.PathLike[str]']) -> bytes:
    """Read a small file whole.

    Args:
        path: The file.

    Returns:
        bytes: Its contents.
    """
    with open(path, 'rb') as handle:
        return handle.read()
