"""
Unit tests for ai.node — the subprocess entrypoint helpers.

ai.node is the Python script that the C engine spawns for every pipeline.
It runs `processArguments` (a blocking C call into the engine) on the
main thread; alongside, it now bootstraps a shared FastAPI WebServer on
the background `server_loop` so EaaS can reach the subprocess for DAP
traffic regardless of pipeline shape.

Because `run()` blocks indefinitely on `processArguments` in production,
this test file targets the small `_setup_shared_web_server()` and
`_teardown_shared_web_server()` helpers in isolation. They're pure-logic
and small-state, exactly the surface that benefits from unit coverage.

These tests pin the contract that the shared-web-server bootstrap must
satisfy:

- ``_setup`` returns ``(None, None)`` when ``--data_port`` is absent from
  ``sys.argv`` (legacy / direct invocations stay working).
- ``_setup`` constructs ``WebServer`` with the parsed host/port when
  ``--data_port=N`` is present, calls ``.use('data')`` on it, schedules
  ``serve()`` on ``server_loop``, and blocks until the server's startup
  callback fires.
- ``_setup`` returns even if the startup callback never fires, logging
  a debug message once the timeout elapses.
- ``_teardown`` is a no-op when given ``(None, None)``.
- ``_teardown`` calls ``server.stop()`` and awaits the future when the
  server is set, swallowing exceptions from either so cleanup never
  masks the original error.
"""

from __future__ import annotations

import asyncio
import sys
import threading
from unittest.mock import MagicMock

import ai.node as node


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _fire_startup_callback_async(on_startup) -> None:
    """Invoke an ``on_startup`` async callback on a fresh background loop.

    Simulates what would happen when ``WebServer.serve()`` triggers the
    lifespan callback — the callback runs on the asyncio loop, sets the
    threading.Event, and releases the caller's blocking wait.
    """

    def fire():
        loop = asyncio.new_event_loop()
        try:
            loop.run_until_complete(on_startup())
        finally:
            loop.close()

    threading.Thread(target=fire, daemon=True).start()


# ---------------------------------------------------------------------------
# _setup_shared_web_server — argv parsing and gating
# ---------------------------------------------------------------------------


def test_setup_returns_None_when_data_port_absent(monkeypatch):
    """No --data_port → return (None, None); legacy invocation stays untouched."""
    monkeypatch.setattr(sys, 'argv', ['node.py'])

    server, future = node._setup_shared_web_server()

    assert server is None
    assert future is None


def test_setup_returns_None_when_only_debug_args_present(monkeypatch):
    """Debug args alone (no --data_port) don't trigger the shared server."""
    monkeypatch.setattr(
        sys,
        'argv',
        ['node.py', '--debug_port=5555', '--debug_host=localhost', '--wait_for_client'],
    )

    server, future = node._setup_shared_web_server()

    assert server is None
    assert future is None


# ---------------------------------------------------------------------------
# _setup_shared_web_server — WebServer construction with --data_port set
# ---------------------------------------------------------------------------


def test_setup_constructs_WebServer_with_parsed_host_and_port(monkeypatch):
    """With --data_port=N --data_host=H, WebServer is built bound to (H, N)."""
    monkeypatch.setattr(sys, 'argv', ['node.py', '--data_port=12345', '--data_host=127.0.0.1'])

    captured = {}

    def fake_web_server(config=None, on_startup=None, **kwargs):
        captured['config'] = config
        captured['on_startup'] = on_startup
        _fire_startup_callback_async(on_startup)
        return MagicMock(name='WebServer-instance')

    monkeypatch.setattr('ai.web.WebServer', fake_web_server)
    monkeypatch.setattr('asyncio.run_coroutine_threadsafe', lambda coro, loop: MagicMock(name='future'))

    node._setup_shared_web_server()

    assert captured['config']['host'] == '127.0.0.1'
    assert captured['config']['port'] == 12345


def test_setup_defaults_host_to_localhost_when_only_data_port_provided(monkeypatch):
    """--data_port alone → host defaults to localhost (cloud-safe default)."""
    monkeypatch.setattr(sys, 'argv', ['node.py', '--data_port=20001'])

    captured = {}

    def fake_web_server(config=None, on_startup=None, **kwargs):
        captured['config'] = config
        _fire_startup_callback_async(on_startup)
        return MagicMock()

    monkeypatch.setattr('ai.web.WebServer', fake_web_server)
    monkeypatch.setattr('asyncio.run_coroutine_threadsafe', lambda coro, loop: MagicMock())

    node._setup_shared_web_server()

    assert captured['config']['host'] == 'localhost'
    assert captured['config']['port'] == 20001


def test_setup_calls_use_data_on_the_constructed_server(monkeypatch):
    """The shared server must register /task/data via .use('data')."""
    monkeypatch.setattr(sys, 'argv', ['node.py', '--data_port=12345'])

    server_instance = MagicMock(name='WebServer-instance')

    def fake_web_server(config=None, on_startup=None, **kwargs):
        _fire_startup_callback_async(on_startup)
        return server_instance

    monkeypatch.setattr('ai.web.WebServer', fake_web_server)
    monkeypatch.setattr('asyncio.run_coroutine_threadsafe', lambda coro, loop: MagicMock())

    node._setup_shared_web_server()

    server_instance.use.assert_called_once_with('data')


def test_setup_schedules_serve_on_server_loop(monkeypatch):
    """``serve()`` is scheduled on the module-level ``server_loop``."""
    monkeypatch.setattr(sys, 'argv', ['node.py', '--data_port=12345'])

    server_instance = MagicMock(name='WebServer-instance')
    serve_coro = MagicMock(name='serve-coroutine')
    server_instance.serve = MagicMock(return_value=serve_coro)

    captured = {}

    def fake_run_coroutine_threadsafe(coro, loop):
        captured['coro'] = coro
        captured['loop'] = loop
        return MagicMock(name='future')

    def fake_web_server(config=None, on_startup=None, **kwargs):
        _fire_startup_callback_async(on_startup)
        return server_instance

    monkeypatch.setattr('ai.web.WebServer', fake_web_server)
    monkeypatch.setattr('asyncio.run_coroutine_threadsafe', fake_run_coroutine_threadsafe)

    node._setup_shared_web_server()

    # Server.serve() was called and its result was passed to run_coroutine_threadsafe
    server_instance.serve.assert_called_once()
    assert captured['coro'] is serve_coro
    assert captured['loop'] is node.server_loop


def test_setup_returns_server_and_future(monkeypatch):
    """``_setup`` returns the WebServer instance and the scheduled future."""
    monkeypatch.setattr(sys, 'argv', ['node.py', '--data_port=12345'])

    server_instance = MagicMock(name='WebServer-instance')
    future = MagicMock(name='future')

    def fake_web_server(config=None, on_startup=None, **kwargs):
        _fire_startup_callback_async(on_startup)
        return server_instance

    monkeypatch.setattr('ai.web.WebServer', fake_web_server)
    monkeypatch.setattr('asyncio.run_coroutine_threadsafe', lambda coro, loop: future)

    returned_server, returned_future = node._setup_shared_web_server()

    assert returned_server is server_instance
    assert returned_future is future


# ---------------------------------------------------------------------------
# _setup_shared_web_server — startup-event handshake
# ---------------------------------------------------------------------------


def test_setup_blocks_until_on_startup_fires(monkeypatch):
    """``_setup`` must not return until the WebServer's on_startup callback runs."""
    monkeypatch.setattr(sys, 'argv', ['node.py', '--data_port=12345'])

    on_startup_holder = {}
    return_marker = []

    def fake_web_server(config=None, on_startup=None, **kwargs):
        on_startup_holder['cb'] = on_startup
        # Note: do NOT fire on_startup here — the test controls timing.
        return MagicMock()

    monkeypatch.setattr('ai.web.WebServer', fake_web_server)
    monkeypatch.setattr('asyncio.run_coroutine_threadsafe', lambda coro, loop: MagicMock())

    # Use a sub-thread so we can observe whether _setup is still blocked.
    def call_setup():
        node._setup_shared_web_server()
        return_marker.append('returned')

    setup_thread = threading.Thread(target=call_setup, daemon=True)
    setup_thread.start()

    # Give _setup a moment to reach the wait.
    setup_thread.join(timeout=0.2)
    assert return_marker == [], '_setup returned before on_startup fired'

    # Now fire on_startup — _setup should release within milliseconds.
    _fire_startup_callback_async(on_startup_holder['cb'])

    setup_thread.join(timeout=2.0)
    assert return_marker == ['returned'], '_setup did not return after on_startup fired'


def test_setup_returns_even_when_startup_callback_never_fires(monkeypatch):
    """If startup never signals within the timeout, ``_setup`` still returns."""
    monkeypatch.setattr(sys, 'argv', ['node.py', '--data_port=12345'])
    # Make the timeout tiny so the test isn't slow.
    monkeypatch.setattr(node, '_SHARED_SERVER_STARTUP_TIMEOUT_SECONDS', 0.05)

    def fake_web_server(config=None, on_startup=None, **kwargs):
        # Never fire on_startup.
        return MagicMock()

    monkeypatch.setattr('ai.web.WebServer', fake_web_server)
    monkeypatch.setattr('asyncio.run_coroutine_threadsafe', lambda coro, loop: MagicMock())

    debug_messages = []
    monkeypatch.setattr(node, 'debug', lambda msg, *a, **kw: debug_messages.append(str(msg)))

    server, future = node._setup_shared_web_server()

    # Returned despite timeout.
    assert server is not None
    assert future is not None
    # And logged something about the timeout.
    assert any('timeout' in m.lower() or 'startup' in m.lower() for m in debug_messages), (
        f'expected timeout/startup mention in debug log; got {debug_messages!r}'
    )


# ---------------------------------------------------------------------------
# _teardown_shared_web_server — safe cleanup
# ---------------------------------------------------------------------------


def test_teardown_is_noop_for_None_server():
    """Teardown with no server (no --data_port path) must not raise."""
    # Must not raise.
    node._teardown_shared_web_server(None, None)


def test_teardown_calls_stop_and_awaits_future():
    """Teardown calls server.stop() and waits on the future when both are set."""
    server = MagicMock(name='server')
    future = MagicMock(name='future')

    node._teardown_shared_web_server(server, future)

    server.stop.assert_called_once()
    future.result.assert_called_once()


def test_teardown_swallows_stop_exceptions():
    """A stop() exception must not propagate — cleanup must not mask original error."""
    server = MagicMock(name='server')
    server.stop.side_effect = RuntimeError('stop failed')
    future = MagicMock(name='future')

    # Must not raise.
    node._teardown_shared_web_server(server, future)

    server.stop.assert_called_once()


def test_teardown_swallows_future_result_exceptions():
    """A future.result() exception must not propagate either."""
    server = MagicMock(name='server')
    future = MagicMock(name='future')
    future.result.side_effect = RuntimeError('future failed')

    # Must not raise.
    node._teardown_shared_web_server(server, future)

    future.result.assert_called_once()


def test_teardown_still_calls_stop_when_future_is_None():
    """If the future is missing but the server isn't, still stop the server."""
    server = MagicMock(name='server')

    node._teardown_shared_web_server(server, None)

    server.stop.assert_called_once()
