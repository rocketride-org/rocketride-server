# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
LaserData memory node — global (per-pipe) state.

Owns the LaserData connection lifecycle and the async→sync bridge. The Laser
SDK is a native (PyO3) async client whose futures must be created from a
thread with a running event loop, so this module starts one persistent loop
in a daemon thread and submits every SDK call to it via
``run_coroutine_threadsafe``. The connection itself is opened lazily on the
first tool call (a pipeline may never invoke the tool) and closed in
``endGlobal``.
"""

from __future__ import annotations

import asyncio
import concurrent.futures
import os
import threading
from typing import Any, Coroutine

from ai.common.config import Config
from rocketlib import IGlobalBase, OPEN_MODE, debug, error, warning

# Defaults / bounds (avoid magic constants scattered in the code).
_DEFAULT_STREAM = 'rocketride-memory'
_DEFAULT_RECALL_LIMIT = 10
_MAX_RECALL_LIMIT = 200
_DEFAULT_OP_TIMEOUT = 30
_MIN_OP_TIMEOUT = 5
_MAX_OP_TIMEOUT = 600
# endGlobal must not hang a pipe teardown on a wedged connection close.
_CLOSE_TIMEOUT = 5


def _int_or(value: Any, default: int) -> int:
    """Coerce a config value to int, falling back to `default` when malformed."""
    try:
        return int(value) if value is not None else default
    except (TypeError, ValueError):
        return default


class IGlobal(IGlobalBase):
    """Global state for tool_laserdata_memory."""

    connection_string: str = ''
    stream: str = _DEFAULT_STREAM
    namespace: str = ''
    allow_namespace_override: bool = True
    folded: bool = True
    recall_limit: int = _DEFAULT_RECALL_LIMIT
    op_timeout: int = _DEFAULT_OP_TIMEOUT

    _loop: asyncio.AbstractEventLoop | None = None
    _loop_thread: threading.Thread | None = None
    # Guards lazy connect: agents issue parallel tool calls, and an
    # unsynchronized check-then-act would open two connections and leak one.
    _connect_lock: threading.Lock | None = None
    _laser: Any = None
    # Teardown coordination: endGlobal flips _closing and cancels the futures
    # still in _pending so concurrent tool calls fail fast instead of waiting
    # out their full op_timeout against a stopped loop.
    _closing: bool = False
    _pending: Any = None

    def beginGlobal(self) -> None:
        """Validate config and start the bridge loop (once per pipe)."""
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return

        # Install the node-local laser-sdk dependency before it is imported
        # (lazily, on the first connect).
        from depends import depends  # type: ignore

        depends(os.path.join(os.path.dirname(os.path.realpath(__file__)), 'requirements.txt'))

        cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)

        connection_string = str(cfg.get('connection_string') or os.environ.get('LASER_CONNECTION_STRING', '')).strip()
        if not connection_string:
            error(
                'laserdata: connection_string is required — set it in node config or the '
                'LASER_CONNECTION_STRING env var (user:password@host:port)'
            )
            raise ValueError('laserdata: connection_string is required')
        self.connection_string = connection_string

        # The Iggy stream the memory topics live in; the SDK requires a default
        # stream pinned at connect before laser.memory() can be used.
        self.stream = str(cfg.get('stream') or _DEFAULT_STREAM).strip() or _DEFAULT_STREAM

        self.namespace = str(cfg.get('namespace') or '').strip()

        raw_override = cfg.get('allow_namespace_override', True)
        self.allow_namespace_override = raw_override if isinstance(raw_override, bool) else True

        raw_folded = cfg.get('folded', True)
        self.folded = raw_folded if isinstance(raw_folded, bool) else True

        # A malformed number (e.g. a stray string from a hand-edited config)
        # falls back to the default rather than crashing pipe startup.
        self.recall_limit = max(1, min(_MAX_RECALL_LIMIT, _int_or(cfg.get('recall_limit'), _DEFAULT_RECALL_LIMIT)))
        self.op_timeout = max(
            _MIN_OP_TIMEOUT, min(_MAX_OP_TIMEOUT, _int_or(cfg.get('op_timeout'), _DEFAULT_OP_TIMEOUT))
        )

        self._closing = False
        self._pending = set()
        self._connect_lock = threading.Lock()
        self._loop = asyncio.new_event_loop()
        self._loop_thread = threading.Thread(target=self._run_loop, name='tool_laserdata_memory-loop', daemon=True)
        self._loop_thread.start()

    def _run_loop(self) -> None:
        """Thread body: pin the bridge loop to this thread and run it forever."""
        asyncio.set_event_loop(self._loop)
        self._loop.run_forever()

    def run(self, coro: Coroutine, *, timeout: float | None = None) -> Any:
        """Run an SDK coroutine on the bridge loop and wait for the result.

        Called from the engine's synchronous tool-dispatch thread, never from
        the bridge loop itself (that would deadlock). Timeout defaults to the
        configured ``op_timeout``.
        """
        loop = self._loop
        if self._closing or loop is None or not loop.is_running():
            coro.close()
            raise RuntimeError('laserdata: node is not open')
        budget = self.op_timeout if timeout is None else timeout
        future = asyncio.run_coroutine_threadsafe(coro, loop)
        pending = self._pending
        if pending is not None:
            pending.add(future)
        try:
            return future.result(budget)
        except concurrent.futures.CancelledError:
            raise RuntimeError('laserdata: node is closing') from None
        except concurrent.futures.TimeoutError:
            future.cancel()
            raise RuntimeError(f'laserdata: operation timed out after {budget}s') from None
        finally:
            if pending is not None:
                pending.discard(future)

    def get_laser(self) -> Any:
        """Return the shared Laser connection, opening it on first use."""
        laser = self._laser
        if laser is None:
            with self._connect_lock:
                if self._laser is None:
                    self._laser = self.run(_connect(self.connection_string, self.stream))
                    debug('laserdata: connected')
                laser = self._laser
        return laser

    def validateConfig(self) -> None:
        """Warn (without raising) when the connection string is missing."""
        try:
            cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
            connection_string = str(
                cfg.get('connection_string') or os.environ.get('LASER_CONNECTION_STRING', '')
            ).strip()
            if not connection_string:
                warning('connection_string is required')
        except Exception as e:
            warning(str(e))

    def endGlobal(self) -> None:
        """Close the connection, stop the bridge loop, and clear secrets."""
        self._closing = True
        laser, self._laser = self._laser, None
        loop, self._loop = self._loop, None
        thread, self._loop_thread = self._loop_thread, None
        pending, self._pending = self._pending, None

        # Fail concurrent in-flight tool calls fast: a cancelled future raises
        # in its waiting thread immediately instead of sitting out op_timeout
        # against a loop that is about to stop.
        for future in list(pending or ()):
            future.cancel()

        if loop is not None and loop.is_running():
            if laser is not None:
                try:
                    asyncio.run_coroutine_threadsafe(_close(laser), loop).result(_CLOSE_TIMEOUT)
                except Exception as e:
                    # The engine is tearing the pipe down regardless; a failed
                    # close only leaks a connection the process exit reclaims.
                    warning(f'laserdata: connection close failed: {e}')
            loop.call_soon_threadsafe(loop.stop)
        if thread is not None:
            thread.join(timeout=_CLOSE_TIMEOUT)
        if loop is not None and not loop.is_running():
            loop.close()

        self.connection_string = ''


async def _connect(connection_string: str, stream: str) -> Any:
    """Open the Laser connection with a pinned default stream (bridge loop).

    laser-sdk is imported here — after ``depends()`` has installed it and only
    when a tool call actually needs the connection. The default stream must be
    pinned at connect for ``laser.memory(namespace)`` to resolve its topics.
    """
    import laser_sdk

    return await laser_sdk.Laser.connect(connection_string, stream=stream)


async def _close(laser: Any) -> None:
    """Close a Laser connection via its async context-manager exit."""
    await laser.__aexit__(None, None, None)
