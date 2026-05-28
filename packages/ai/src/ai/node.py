import argparse
import sys
import os
import asyncio
import threading
from typing import Optional, Tuple, Any

# Remove auto-added script directory to avoid import conflicts with the ai package
if sys.path and (sys.path[0].endswith('ai') or sys.path[0].endswith('ai\\') or sys.path[0].endswith('ai/')):
    sys.path.pop(0)

# Suppress debugpy frozen modules warning (Python 3.12+)
os.environ['PYDEVD_DISABLE_FILE_VALIDATION'] = '1'

# Import directly from C++
from engLib import debug

# How long to wait for the shared WebServer's startup callback to fire
# before giving up and proceeding to processArguments. The callback fires
# when uvicorn enters its serve loop; the wait is the handshake that
# guarantees the listener is up before EaaS gets a chance to connect.
_SHARED_SERVER_STARTUP_TIMEOUT_SECONDS = 10.0

# Bound for waiting on ``serve()`` after ``server.stop()`` — guards
# against a stuck uvicorn hanging subprocess shutdown forever.
_SHARED_SERVER_SHUTDOWN_TIMEOUT_SECONDS = 5.0

# Module-level reference to the shared subprocess WebServer.
# Set by `run()` when `--data_port` is provided in `sys.argv`; remains None
# otherwise. Source nodes (webhook, telegram) discover this from inside
# their `_run()` via `from ai.node import shared_web_server`.
shared_web_server: Optional[Any] = None

# Global shared event loop for async operations in worker threads
# Usage: from ai.node import server_loop
#        future = asyncio.run_coroutine_threadsafe(my_async_func(), server_loop)
#        result = future.result()


def _create_loop():
    """Create the event loop immediately."""
    loop = asyncio.new_event_loop()

    def run_loop():
        asyncio.set_event_loop(loop)
        loop.run_forever()

    thread = threading.Thread(target=run_loop, daemon=True, name='GlobalEventLoop')
    thread.start()
    return loop


# Initialize at module import time
server_loop = _create_loop()
_loop_thread = None
_loop_ready = threading.Event()


def _start_event_loop():
    """Log that event loop is ready (already started at import time)."""
    pass


def _stop_event_loop():
    """Stop the global event loop."""
    global server_loop, _loop_thread

    if server_loop:
        server_loop.call_soon_threadsafe(server_loop.stop)
        if _loop_thread:
            _loop_thread.join(timeout=5)
        server_loop = None
        _loop_thread = None


def _parse_data_host_port(default_port: Optional[int] = None) -> Tuple[str, Optional[int]]:
    """Parse ``--data_host`` / ``--data_port`` from ``sys.argv``.

    ``default_port=None`` lets the caller treat absence as "no shared
    server requested" (used by ``_setup_shared_web_server``). A numeric
    default keeps the legacy self-hosted fallback in webhook/telegram
    working when EaaS didn't pass the flag.
    """
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument('--data_host', type=str, default='localhost')
    parser.add_argument('--data_port', type=int, default=default_port)
    args, _unknown = parser.parse_known_args(sys.argv)
    return args.data_host, args.data_port


def _setup_shared_web_server() -> Tuple[Optional[Any], Optional[Any]]:
    """Bootstrap the shared subprocess WebServer when ``--data_port`` is set.

    EaaS spawns every subprocess with ``--data_port=N`` so DAP traffic
    (data flow, profiling, future trace control) can reach this process
    on ``ws://localhost:N/task/data`` regardless of pipeline shape. This
    function constructs the WebServer on the existing ``server_loop``
    daemon thread, registers the ``data`` module (which exposes
    ``/task/data``), and blocks until the server signals it is up.

    Source nodes (webhook, telegram) discover the server via
    ``from ai.node import shared_web_server`` from inside their
    ``_run()`` method, then write ``state.target`` for the ``data``
    module to pick up lazily.

    Legacy invocations (direct ``python node.py`` without ``--data_port``)
    keep working: this function returns ``(None, None)`` and source nodes
    fall back to constructing their own WebServer.

    Returns:
        A tuple ``(server, future)`` — both ``None`` if ``--data_port``
        is absent; otherwise the WebServer instance and the concurrent
        future returned by ``asyncio.run_coroutine_threadsafe`` so the
        caller can clean it up in a ``finally`` block.
    """
    data_host, data_port = _parse_data_host_port(default_port=None)

    if data_port is None:
        # Legacy / test invocation — no shared server. Source nodes that
        # need a WebServer fall back to their pre-refactor self-hosted path.
        return None, None

    # Local import: keeps the cold-start cost paid only when needed and
    # avoids dragging the FastAPI/uvicorn dep into legacy invocations.
    from ai.web import WebServer

    # Event the on_startup callback sets when the server is ready to
    # accept connections. Main thread waits on this to guarantee EaaS
    # never connects before the listener is bound.
    startup_ready = threading.Event()

    async def _on_startup() -> None:
        startup_ready.set()

    server = WebServer(
        config={'host': data_host, 'port': data_port},
        on_startup=_on_startup,
    )
    # Mount `/task/data` — the WebSocket EaaS uses to send DAP traffic
    # (data ops, cprofile, future trace control). Done here, NOT in a
    # source node's `_run()`, so sourceless pipelines (agentic, RAG,
    # batch) are reachable by EaaS too — that's the whole reason this
    # PR moved the server out of source nodes. The `data` module's
    # lazy-target contract lets it load before any source has set
    # `state.target`.
    server.use('data')

    future = asyncio.run_coroutine_threadsafe(server.serve(), server_loop)

    # Block until the server's lifespan startup callback fires, with a
    # safety-net timeout so a misbehaving uvicorn can't deadlock the
    # subprocess. The timeout is generous in production (10s) and is
    # dialled down by tests.
    signalled = startup_ready.wait(timeout=_SHARED_SERVER_STARTUP_TIMEOUT_SECONDS)

    # Fail fast if `serve()` exited before signalling startup (e.g. bind
    # error, permission denied, port already in use). Without this check
    # we'd publish a dead `shared_web_server` whose `/task/data` is
    # unreachable for the rest of the subprocess lifetime, and source
    # nodes would silently fail when they try to write `state.target`.
    if future.done():
        future.result()  # re-raises the exception from serve()

    if not signalled:
        debug(
            f'shared WebServer startup did not signal within '
            f'{_SHARED_SERVER_STARTUP_TIMEOUT_SECONDS}s; proceeding anyway'
        )

    return server, future


def _teardown_shared_web_server(server: Optional[Any], future: Optional[Any]) -> None:
    """Stop the shared WebServer and wait briefly for serve() to return.

    Called from ``run()``'s ``finally`` block. Must be exception-safe so
    cleanup never masks the original error path. A failure here is logged
    via ``debug`` but never re-raised.

    Args:
        server: The WebServer instance returned by ``_setup_shared_web_server``.
            ``None`` for legacy invocations — the function is a no-op.
        future: The concurrent future returned by ``run_coroutine_threadsafe``.
            ``None`` is tolerated for symmetry / partial-setup paths.
    """
    if server is None:
        return

    try:
        server.stop()
    except Exception as e:
        debug(f'shared WebServer stop() raised: {e}')

    # `server.stop()` only flips `should_exit`; `serve()` keeps running
    # until uvicorn closes sockets, drains in-flight requests, and fires
    # `on_shutdown`. Wait for `serve()` to actually return BEFORE the
    # caller's `_stop_event_loop()` closes `server_loop` underneath it.
    # Swallow any exception so cleanup never masks the original error
    # path that triggered teardown.
    if future is not None:
        try:
            future.result(timeout=_SHARED_SERVER_SHUTDOWN_TIMEOUT_SECONDS)
        except Exception as e:
            debug(f'shared WebServer serve() future raised: {e}')


def run():
    """
    Execute the script.
    """
    import os

    # Inject mock modules path if set (for testing)
    mock_path = os.environ.get('ROCKETRIDE_MOCK')
    if mock_path:
        sys.path.insert(0, mock_path)

    # Parse arguments
    parser = argparse.ArgumentParser(add_help=False)  # Don't interfere with main arg parsing
    parser.add_argument('--debug_host', type=str, default=None)
    parser.add_argument('--debug_port', type=int, default=None)
    parser.add_argument('--wait_for_client', action='store_true', default=False)

    # Parse only the args we care about, ignore unknown ones
    parsed_args, _ = parser.parse_known_args(sys.argv)

    # Connect to parent process debugpy if arguments provided
    if parsed_args.debug_host and parsed_args.debug_port:
        try:
            import debugpy

            # Get connection details (use debug_host if data_host not provided)
            debug_host = parsed_args.debug_host
            debug_port = parsed_args.debug_port

            debugpy.listen(
                (
                    debug_host,
                    debug_port,
                ),
                in_process_debug_adapter=True,
            )

            # Enable debugging for this thread
            debugpy.debug_this_thread()

            # If we are supposed to wait for the client attach, do so
            if parsed_args.wait_for_client:
                debugpy.wait_for_client()

        except Exception as e:
            import logging

            logging.getLogger(__name__).warning('Failed to initialize debugpy: %s', e)

    # Start the global event loop for async operations
    _start_event_loop()

    # Bootstrap the shared subprocess WebServer (if EaaS passed --data_port).
    # Must happen BEFORE processArguments because that call blocks the main
    # thread for the pipeline's lifetime; the WebServer runs concurrently
    # on the existing server_loop daemon thread. Exposing as a module
    # global so source nodes can pick it up later via
    # `from ai.node import shared_web_server` inside their _run().
    global shared_web_server
    shared_web_server, _shared_web_server_future = _setup_shared_web_server()

    # CRITICAL — `__main__` vs `ai.node` module duality.
    #
    # engine.exe spawns this file as a script, so Python loads it as
    # `sys.modules['__main__']`. The `global shared_web_server` above
    # therefore writes to `__main__.shared_web_server`. When source nodes
    # later do `from ai import node`, Python would otherwise
    # import the file AGAIN as `sys.modules['ai.node']` — a SEPARATE module
    # that would re-run all top-level code, INCLUDING creating a second
    # `server_loop` daemon thread (see `_create_loop()` at module top).
    # Source nodes would then see `ai.node.server_loop` (loop B) while the
    # shared `WebServer.serve()` was scheduled on `__main__.server_loop`
    # (loop A) — two unaware event loops, broken cross-thread scheduling.
    #
    # Aliasing `ai.node` to this very module object via `setdefault` makes
    # both names resolve to the same module: same `server_loop`, same
    # `shared_web_server`, no second module evaluation.
    #
    # Thread-safety: this runs ONCE on the main thread before
    # `processArguments` starts the C engine (which is what eventually
    # spawns the source-node threads). Single-writer, sequenced-before
    # any reader. No lock needed; Python's GIL guarantees atomicity of
    # the attribute store.
    try:
        _ai_node_mod = sys.modules.setdefault('ai.node', sys.modules[__name__])
        _ai_node_mod.shared_web_server = shared_web_server
    except Exception as e:
        debug(f'failed to mirror shared_web_server into ai.node: {e}')

    # Block direct GPU library imports (torch, tensorflow, etc.) when running
    # in model server mode — all GPU inference goes through ModelClient RPC
    from ai.common.models.gpu_guard import install_gpu_guard

    install_gpu_guard()

    # This will actually do the dependency loading and start the main process
    from rocketlib import processArguments, monitorStatus

    # Update the status
    monitorStatus('Loading pipeline')

    try:
        # Start the main engine process (this will block)
        processArguments(sys.argv)
    finally:
        # Tear down the shared WebServer (if any) before the event loop
        # closes — its serve() coroutine is running on server_loop.
        _teardown_shared_web_server(shared_web_server, _shared_web_server_future)
        shared_web_server = None
        # Mirror the reset to ai.node (see comment at the assignment above).
        try:
            _ai_node_mod = sys.modules.get('ai.node')
            if _ai_node_mod is not None:
                _ai_node_mod.shared_web_server = None
        except Exception:
            pass
        # Stop the event loop on exit
        _stop_event_loop()


if __name__ == '__main__':
    try:
        run()

    except Exception as e:
        debug(e)

    except (KeyboardInterrupt, SystemExit):
        pass
