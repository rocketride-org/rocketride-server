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
Process-wide CrewAI kickoff runner.

CrewAI's process-global singletons (`crewai_event_bus`, `EventListener`,
`ConsoleFormatter`, `Telemetry`) are not safe under concurrent kickoffs from
multiple threads.  This module funnels every `crew.akickoff(...)` call from
every CrewAI node in the process onto a single asyncio event loop running on
one daemon thread.  Asyncio's single-threaded cooperative scheduling guarantees
that CrewAI internals only ever execute on that one thread, eliminating the
race entirely.  True concurrency still happens at await points (LLM calls
mainly), so multiple chats can overlap their IO without ever stepping on each
other.

Per-call routing is handled by `crewContext`, a `ContextVar` set inside the
submission wrapper.  CrewAI's bus already propagates contextvars across the
worker-thread boundary when it dispatches event handlers, so the persistent
listener in `crewai_listener.py` can read `crewContext.get()` from any handler
worker thread and find the originating run's `AgentContext`.
"""

from __future__ import annotations

import asyncio
import contextvars
import threading
from concurrent.futures import Future
from typing import TYPE_CHECKING, Any, Coroutine, Optional

if TYPE_CHECKING:
    from ai.common.agent import AgentContext


# ── Per-task routing context ──────────────────────────────────────────────────

# Set by `CrewRunner.submit` inside the wrapper coroutine for each run.  Read
# by the persistent listener's dispatcher (in crewai_listener.py) to find the
# AgentContext that owns whatever event the bus is dispatching.  CrewAI's bus
# uses `contextvars.copy_context().run(...)` when submitting sync handlers to
# its `_sync_executor`, which means our value automatically propagates to
# handler worker threads without any extra plumbing.
crewContext: contextvars.ContextVar[Optional['AgentContext']] = contextvars.ContextVar('crewContext', default=None)


# ── CrewRunner ────────────────────────────────────────────────────────────────


class CrewRunner:
    """
    Owns one daemon thread running an asyncio event loop, dedicated to running
    CrewAI kickoff coroutines submitted from arbitrary worker threads.

    Submit a `crew.akickoff(...)` coroutine via `submit(context, coro)`.  The
    runner schedules the coroutine on its loop thread, blocks the calling
    worker on the result, and returns the kickoff's output once it completes.
    Two concurrent submits run cooperatively on the same loop thread; their
    coroutines interleave at await points and never step on CrewAI's globals.
    """

    def __init__(self) -> None:
        """Create the loop and start the daemon thread that runs it forever."""
        self._loop: asyncio.AbstractEventLoop = asyncio.new_event_loop()
        self._thread: threading.Thread = threading.Thread(
            target=self._run_loop,
            name='CrewKickoffLoop',
            daemon=True,
        )
        self._thread.start()

    def _run_loop(self) -> None:
        """Daemon-thread entry point: bind the loop and run it forever."""
        asyncio.set_event_loop(self._loop)
        self._loop.run_forever()

    def submit(self, context: 'AgentContext', coro: Coroutine[Any, Any, Any]) -> Any:
        """
        Submit a kickoff coroutine bound to a per-run context.

        Wraps `coro` in an inner coroutine that sets `crewContext = context`
        before awaiting it.  Each wrapper becomes its own asyncio Task with
        its own contextvar slot, so concurrent submits never see each other's
        context.  Blocks the calling worker thread on the kickoff's result.

        Args:
            context: The current run's AgentContext (carries invoker for SSE routing).
            coro: A coroutine, typically `crew.akickoff(inputs=...)`.

        Returns:
            The kickoff's return value (CrewOutput or CrewStreamingOutput).

        Raises:
            Whatever the kickoff raises -- propagated through `future.result()`.
        """

        async def _wrapper() -> Any:
            crewContext.set(context)
            return await coro

        future: Future[Any] = asyncio.run_coroutine_threadsafe(_wrapper(), self._loop)
        return future.result()


# ── Process-wide singleton accessor ───────────────────────────────────────────

_shared_runner: Optional[CrewRunner] = None
_shared_runner_lock = threading.Lock()


def get_shared_runner() -> CrewRunner:
    """
    Return the process-wide `CrewRunner`, creating it lazily on first call.

    Also installs the persistent CrewAI event listener (via the lazy import
    of `crewai_listener.ensure_registered`) so that callers don't need to do
    both initialization steps separately.  The lazy import avoids the
    circular dependency that would otherwise exist between this module and
    `crewai_listener.py` (which imports `crewContext` from here).

    Idempotent and thread-safe -- subsequent calls just return the cached
    runner under the fast path.
    """
    global _shared_runner
    if _shared_runner is None:
        with _shared_runner_lock:
            if _shared_runner is None:
                # Lazy import to avoid the crewai_listener -> crewai_runner cycle.
                from .crewai_listener import ensure_registered

                ensure_registered()
                _shared_runner = CrewRunner()
    return _shared_runner
