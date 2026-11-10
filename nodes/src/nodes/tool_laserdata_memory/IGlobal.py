# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
LaserData memory node - global (per-pipe) state.

Owns the LaserData connection lifecycle and the async-to-sync bridge. The Laser
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

from rocketlib import IGlobalBase, debug, error, warning

# Bound the instance applies to the agent's per-call recall limit (the schema
# bounds the configured default the same way).
MAX_RECALL_LIMIT = 200
# endGlobal must not hang a pipe teardown on a wedged connection close.
_CLOSE_TIMEOUT = 5


class IGlobal(IGlobalBase):
    """Global state for tool_laserdata_memory."""

    connection_string: str = ''
    stream: str = 'rocketride-memory'
    namespace: str = ''
    allow_namespace_override: bool = True
    folded: bool = True
    recall_limit: int = 10
    op_timeout: int = 30

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
        """Read the resolved config and start the bridge loop (once per pipe)."""
        # Install the node-local laser-sdk dependency before it is imported
        # (lazily, on the first connect).
        from depends import depends  # type: ignore

        depends(os.path.join(os.path.dirname(os.path.realpath(__file__)), 'requirements.txt'))

        # The resolved config: the selected deployment's connection string
        # flattened beside the shared leaves, bounds and types validated
        cfg = self.config

        # The connection string reaches the node through its config (a
        # ${ROCKETRIDE_LASERDATA_CONNECTION_STRING} reference resolved per call);
        # there is no process-env fallback
        connection_string = str(cfg.connection_string or '').strip()
        if not connection_string:
            error('laserdata: connection_string is required (user:password@host:port)')
            raise ValueError('laserdata: connection_string is required')
        self.connection_string = connection_string

        # The Iggy stream the memory topics live in; the SDK requires a default
        # stream pinned at connect before laser.memory() can be used.
        self.stream = cfg.stream.strip()
        self.namespace = str(cfg.namespace or '').strip()
        self.allow_namespace_override = cfg.allow_namespace_override
        self.folded = cfg.folded
        self.recall_limit = cfg.recall_limit
        self.op_timeout = cfg.op_timeout

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

    laser-sdk is imported here - after ``depends()`` has installed it and only
    when a tool call actually needs the connection. The default stream must be
    pinned at connect for ``laser.memory(namespace)`` to resolve its topics.
    """
    import laser_sdk

    return await laser_sdk.Laser.connect(connection_string, stream=stream)


async def _close(laser: Any) -> None:
    """Close a Laser connection via its async context-manager exit."""
    await laser.__aexit__(None, None, None)
