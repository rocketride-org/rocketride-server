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

# =========================================================================
# Persistent per-node event loop
#
# The engine calls into Python synchronously, one op at a time, from any of
# its threads. A node that wants an async client therefore has nowhere to
# keep it: ``asyncio.run()`` per op builds and tears down a loop each call,
# and anything bound to that loop — a connection pool, a websocket, an
# ``asyncio.Lock`` — dies with it. Every node that needed one has grown its
# own loop thread by hand, each with its own timeout and shutdown bugs.
#
# AsyncBridge is that thread, written once. One loop lives on one daemon
# thread for as long as the node does, sync callers hand coroutines to it
# and block for the result, and the state those coroutines create outlives
# the call that made it.
# =========================================================================

from __future__ import annotations

import asyncio
import concurrent.futures
import inspect
import threading
import time
from typing import Any, Awaitable, Optional

from .error import APERR, Ec

#: How long to wait for the loop thread to report itself running. Reaching this
#: means the interpreter could not schedule a fresh daemon thread at all, so the
#: bridge fails loudly rather than handing back a loop nothing is driving.
_START_TIMEOUT = 10.0

#: Longest a caller sleeps before re-checking that the loop thread is still alive.
#: An untimed run() would otherwise block an engine thread forever if the thread
#: died mid-op; this turns that hang into an error.
_WAIT_SLICE = 1.0


class AsyncBridge:
    """One persistent asyncio loop on a daemon thread; sync callers submit coroutines to it.

    The loop is started on first use and stopped by :meth:`close`. Everything a
    coroutine creates on it — pools, locks, tasks — stays valid for every later
    call, which is the whole point of the class.
    """

    def __init__(self, name: str) -> None:
        """
        Create a bridge that has not yet started anything.

        Args:
            name (str): Label for the loop thread and for error messages. Usually
                the node's logical type.
        """
        self._name = str(name)
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._thread: Optional[threading.Thread] = None
        self._closed = False
        #: Set by the loop thread on its way out. Distinct from _closed, which is
        #: set by whoever asked for the shutdown: a thread that died on its own
        #: must stop new work just as firmly, but close() still has to tidy up.
        self._dead = False
        self._lock = threading.Lock()

    @property
    def loop(self) -> asyncio.AbstractEventLoop:
        """
        The node's event loop, started on first access.

        Returns:
            asyncio.AbstractEventLoop: The running loop, the same object every time.

        Raises:
            RuntimeError: When the bridge is closed, or its thread has died.
        """
        with self._lock:
            return self._loop_locked()

    @property
    def is_running(self) -> bool:
        """True while this bridge owns a live loop on a live thread."""
        loop = self._loop
        thread = self._thread
        if loop is None or thread is None or self._closed or self._dead:
            return False
        return thread.is_alive() and loop.is_running()

    def run(self, coro: Awaitable[Any], *, timeout: Optional[float] = None) -> Any:
        """
        Run an awaitable on the node loop and block until it finishes.

        Args:
            coro (Awaitable[Any]): The coroutine — or any awaitable — to run.
            timeout (Optional[float]): Seconds to wait, or None for no limit.

        Returns:
            Any: Whatever the awaitable returned.

        Raises:
            APERR: ``Ec.Timeout`` when *timeout* elapses first; the awaitable is
                cancelled rather than left running into a result nobody reads.
            RuntimeError: When the bridge is closed, is closing, when its thread
                dies mid-op, or when called from the loop thread itself.
            Exception: Anything the awaitable raised, unchanged — with one
                exception: a cancellation crosses the thread boundary as a
                ``concurrent.futures.CancelledError``, losing the original
                ``asyncio.CancelledError`` and its message.
        """
        # Submission happens under the lock so close() cannot land between the
        # liveness check and the hand-off. Anything that fails in here leaves the
        # coroutine unscheduled, so it is closed rather than left "never awaited".
        try:
            with self._lock:
                # Blocking on our own loop would block the thread that has to run
                # the coroutine. Caught here because the deadlock is silent otherwise.
                if self._thread is not None and threading.current_thread() is self._thread:
                    raise RuntimeError(
                        f'{self._name}: run_async() cannot be called from the node event loop thread '
                        f'(would deadlock); await the coroutine instead'
                    )
                loop = self._loop_locked()
                future = asyncio.run_coroutine_threadsafe(self._as_coroutine(coro), loop)
        except BaseException:
            self._discard(coro)
            raise

        self._wait(future, timeout)

        try:
            return future.result()
        except concurrent.futures.CancelledError:
            # Only shutdown rewrites the error; a coroutine cancelled for its own
            # reasons must reach the caller as the cancellation it was.
            if self._closed or self._dead:
                raise RuntimeError(f'{self._name}: node is closing') from None
            raise

    def _wait(self, future: 'concurrent.futures.Future', timeout: Optional[float]) -> None:
        """
        Block until *future* finishes, failing loudly if the loop dies first.

        Waits in slices rather than one call: an untimed wait on a thread that has
        gone away never returns, and it is an engine thread holding the GIL.

        Args:
            future (concurrent.futures.Future): The submitted work.
            timeout (Optional[float]): Seconds allowed, or None for no limit.

        Raises:
            APERR: ``Ec.Timeout`` when *timeout* runs out.
            RuntimeError: When the loop stops with the work still outstanding.
        """
        deadline = None if timeout is None else time.monotonic() + timeout

        while True:
            slice_ = _WAIT_SLICE
            if deadline is not None:
                slice_ = min(_WAIT_SLICE, max(deadline - time.monotonic(), 0.0))

            # wait() rather than result(timeout): since 3.11 a wait timeout and a
            # TimeoutError raised by the coroutine itself are the same class, and
            # the coroutine's own error must reach the caller unchanged.
            done, _ = concurrent.futures.wait([future], timeout=slice_)

            # future.done() as well as wait()'s verdict: wait() counts only
            # FINISHED and CANCELLED_AND_NOTIFIED, so a future cancelled before the
            # waiter was installed stays "not done" to it forever — which would spin
            # this loop on a healthy bridge, or report a timeout that never happened.
            if done or future.done():
                return

            if deadline is not None and time.monotonic() >= deadline:
                future.cancel()
                raise APERR(Ec.Timeout, f'{self._name}: async operation timed out after {timeout}s')

            if not self.is_running:
                future.cancel()
                if self._closed or self._dead:
                    raise RuntimeError(f'{self._name}: node is closing')
                raise RuntimeError(f'{self._name}: the node event loop stopped while an operation was in flight')

    def close(self, *, join_timeout: float = 5.0) -> None:
        """
        Stop the loop and its thread. Idempotent, and safe when nothing ever started.

        Pending tasks are cancelled and given until *join_timeout* to unwind, so a
        coroutine holding a socket or a pool gets its ``finally`` before the loop
        goes away.

        Args:
            join_timeout (float): Seconds allowed for the drain and for the thread
                to exit, each.
        """
        with self._lock:
            if self._closed:
                return
            self._closed = True
            loop = self._loop
            thread = self._thread

        if loop is None:
            # Nothing was ever started; marking it closed is the whole job.
            return

        # Closing from inside the loop would join the current thread. Ask it to
        # stop and leave the rest to whoever started it.
        if thread is not None and threading.current_thread() is thread:
            self._stop(loop)
            return

        # A loop that already stopped runs nothing, so draining it only stalls.
        if not self._dead:
            self._drain(loop, join_timeout)
        self._stop(loop)

        if thread is not None:
            thread.join(join_timeout)
            if thread.is_alive():
                self._warn(f'{self._name}: event loop thread did not stop within {join_timeout}s')
                return

        if not loop.is_closed():
            loop.close()

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    def _loop_locked(self) -> asyncio.AbstractEventLoop:
        """
        Return the live loop, starting it if needed. Caller holds the lock.

        Returns:
            asyncio.AbstractEventLoop: A loop with a thread actually driving it.

        Raises:
            RuntimeError: When the bridge is closed or its thread has died — never
                a loop nothing is running, which would swallow every submission.
        """
        if self._closed:
            raise RuntimeError(f'{self._name}: the node event loop is closed')
        if self._loop is None:
            self._start()
            return self._loop

        # Liveness is read from the loop and the thread, not only from the _dead flag:
        # run_forever() clears its running state before the flag is set, and a caller
        # landing in that window would otherwise be handed a loop nothing drives.
        if self._dead or not self.is_running:
            raise RuntimeError(f'{self._name}: the node event loop thread is gone')
        return self._loop

    def _start(self) -> None:
        """Start the loop thread. Called with the lock held, once per bridge."""
        loop = asyncio.new_event_loop()
        ready = threading.Event()

        def _serve() -> None:
            asyncio.set_event_loop(loop)
            loop.call_soon(ready.set)
            try:
                loop.run_forever()
            finally:
                # run_forever() returning — a stop(), or an error escaping the loop —
                # means no further submission can ever complete. Say so, so callers
                # fail instead of blocking on work nothing will pick up.
                self._dead = True
                asyncio.set_event_loop(None)

        thread = threading.Thread(target=_serve, name=f'{self._name}-loop', daemon=True)
        # Published before start() on purpose: call_soon_threadsafe queues onto a
        # loop that is not running yet, so a caller racing us here submits safely.
        self._loop = loop
        self._thread = thread
        thread.start()

        # Callers immediately submit work, and run_coroutine_threadsafe on a loop
        # that is not running yet simply never completes.
        if not ready.wait(_START_TIMEOUT):
            # Roll back rather than leave a half-built bridge behind: a loop nobody
            # runs would accept submissions and finish none of them.
            self._loop = None
            self._thread = None
            self._closed = True
            if not loop.is_closed():
                loop.close()
            raise RuntimeError(f'{self._name}: event loop thread did not start within {_START_TIMEOUT}s')

    def _drain(self, loop: asyncio.AbstractEventLoop, join_timeout: float) -> None:
        """Cancel everything still on the loop and let it unwind, bounded by *join_timeout*."""
        try:
            future = asyncio.run_coroutine_threadsafe(self._cancel_all(), loop)
        except RuntimeError:
            # Loop already closed underneath us — nothing left to drain.
            return
        try:
            future.result(join_timeout)
        except (concurrent.futures.TimeoutError, concurrent.futures.CancelledError, asyncio.CancelledError):
            self._warn(f'{self._name}: pending async tasks did not finish within {join_timeout}s')
        except Exception:
            # A task failing on the way out changes nothing about the shutdown.
            pass

    @staticmethod
    async def _cancel_all() -> None:
        """Cancel every task on this loop except the one doing the cancelling."""
        current = asyncio.current_task()
        pending = [task for task in asyncio.all_tasks() if task is not current]
        for task in pending:
            task.cancel()
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)

    @staticmethod
    def _stop(loop: asyncio.AbstractEventLoop) -> None:
        """Ask the loop to leave run_forever(), tolerating a loop already gone."""
        try:
            loop.call_soon_threadsafe(loop.stop)
        except RuntimeError:
            pass

    @staticmethod
    async def _await(awaitable: Awaitable[Any]) -> Any:
        """Adapt a non-coroutine awaitable (a Future, a custom __await__) to a coroutine."""
        return await awaitable

    @classmethod
    def _as_coroutine(cls, coro: Awaitable[Any]) -> Any:
        """
        Return *coro* as something run_coroutine_threadsafe accepts.

        Args:
            coro (Awaitable[Any]): The value handed to :meth:`run`.

        Returns:
            Any: A coroutine object.

        Raises:
            TypeError: When the value cannot be awaited at all.
        """
        if asyncio.iscoroutine(coro):
            return coro
        if inspect.isawaitable(coro):
            return cls._await(coro)
        raise TypeError(f'expected a coroutine or awaitable, got {type(coro).__name__}')

    @staticmethod
    def _discard(coro: Any) -> None:
        """Close a coroutine that will never be run, so Python does not warn about it."""
        close = getattr(coro, 'close', None)
        if callable(close):
            close()

    @staticmethod
    def _warn(message: str) -> None:
        """Report a shutdown problem through the engine log.

        Imported here rather than at module scope: engine.py reaches this module
        through filters.py, so a top-level import would be circular.
        """
        from .engine import warning

        warning(message)
