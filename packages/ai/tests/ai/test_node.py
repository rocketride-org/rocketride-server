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
import time
from unittest.mock import MagicMock

import pytest

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


def _fire_startup_callback_now(on_startup) -> None:
    """Invoke an ``on_startup`` async callback and return once it has run.

    Unlike :pyfunc:`_fire_startup_callback_async`, the event is set before this
    returns. Tests that need ``signalled`` to be true use this so they cannot
    race the wait's own timeout on a loaded machine.
    """
    loop = asyncio.new_event_loop()
    try:
        loop.run_until_complete(on_startup())
    finally:
        loop.close()


# ---------------------------------------------------------------------------
# _setup_shared_web_server — argv parsing and gating
# ---------------------------------------------------------------------------


def test_setup_returns_none_when_data_port_absent(monkeypatch):
    """No --data_port → no server, no error.

    Nothing to bind, and a pipeline with no Python source node never needs
    the DAP channel.
    """
    monkeypatch.setattr(sys, 'argv', ['node.py'])

    assert node._setup_shared_web_server() == (None, None)


def test_setup_returns_none_when_only_debug_args_present(monkeypatch):
    """Debug args alone don't imply a data channel — only --data_port does."""
    monkeypatch.setattr(
        sys,
        'argv',
        ['node.py', '--debug_port=5555', '--debug_host=localhost', '--wait_for_client'],
    )

    assert node._setup_shared_web_server() == (None, None)


def test_setup_builds_no_server_when_data_port_absent(monkeypatch):
    """The no-port path must not construct a WebServer at all — not even an unbound one."""
    constructed = []

    def fake_web_server(config=None, on_startup=None, **kwargs):
        constructed.append(config)
        return MagicMock(name='WebServer-instance')

    monkeypatch.setattr(sys, 'argv', ['node.py'])
    monkeypatch.setattr('ai.web.WebServer', fake_web_server)

    node._setup_shared_web_server()

    assert constructed == []


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

    assert captured['config']['host'] == '127.0.0.1'
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
    # Signal-based handoff: the fake server sets this once it has captured
    # the callback, so the test never races against `_setup_shared_web_server`
    # on a slow runner.
    callback_captured = threading.Event()

    def fake_web_server(config=None, on_startup=None, **kwargs):
        on_startup_holder['cb'] = on_startup
        callback_captured.set()
        # Note: do NOT fire on_startup here — the test controls timing.
        return MagicMock()

    # A real serve() future is pending while the server runs, and the wait polls
    # it: a bare MagicMock would report done() truthy and end the wait at once.
    pending_future = MagicMock(name='future')
    pending_future.done.return_value = False

    monkeypatch.setattr('ai.web.WebServer', fake_web_server)
    monkeypatch.setattr('asyncio.run_coroutine_threadsafe', lambda coro, loop: pending_future)

    # Use a sub-thread so we can observe whether _setup is still blocked.
    def call_setup():
        node._setup_shared_web_server()
        return_marker.append('returned')

    setup_thread = threading.Thread(target=call_setup, daemon=True)
    setup_thread.start()

    # Wait for the fake server to capture the callback before touching it.
    assert callback_captured.wait(timeout=2.0), 'on_startup callback was never captured'

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

    # A live serve() future is pending. A bare MagicMock reports done() truthy,
    # which would end both waits on their first pass and leave the 0.05s budget
    # unspent — the timeout path this test exists for would never be reached.
    pending_future = MagicMock(name='future')
    pending_future.done.return_value = False

    monkeypatch.setattr('ai.web.WebServer', fake_web_server)
    monkeypatch.setattr('asyncio.run_coroutine_threadsafe', lambda coro, loop: pending_future)

    debug_messages = []
    monkeypatch.setattr(node, 'debug', lambda msg, *a, **kw: debug_messages.append(str(msg)))
    monkeypatch.setattr(node, 'warning', lambda msg, *a, **kw: None)

    server, future = node._setup_shared_web_server()

    # Returned despite timeout.
    assert server is not None
    assert future is not None
    # And logged something about the timeout.
    assert any('timeout' in m.lower() or 'startup' in m.lower() for m in debug_messages), (
        f'expected timeout/startup mention in debug log; got {debug_messages!r}'
    )


def test_setup_reraises_when_serve_future_already_failed(monkeypatch):
    """If ``serve()`` exits before signalling startup, ``_setup`` must re-raise.

    Pins the fail-fast contract: rather than publishing a dead ``shared_web_server``
    whose ``/task/data`` is unreachable for the rest of the subprocess lifetime,
    the call site must surface the bind-failure exception immediately so source
    nodes don't silently fail when they try to write ``state.target``.
    """
    monkeypatch.setattr(sys, 'argv', ['node.py', '--data_port=12345'])
    # Tiny timeout: the wait elapses, then the done()/result() branch fires.
    monkeypatch.setattr(node, '_SHARED_SERVER_STARTUP_TIMEOUT_SECONDS', 0.05)

    future = MagicMock(name='future')
    future.done.return_value = True
    future.result.side_effect = RuntimeError('bind failed')

    def fake_web_server(config=None, on_startup=None, **kwargs):
        return MagicMock(name='WebServer-instance')

    monkeypatch.setattr('ai.web.WebServer', fake_web_server)
    monkeypatch.setattr('asyncio.run_coroutine_threadsafe', lambda coro, loop: future)

    with pytest.raises(RuntimeError, match='bind failed'):
        node._setup_shared_web_server()


def test_setup_reraises_without_waiting_out_the_timeout(monkeypatch):
    """A ``serve()`` that dies before the callback fires is reported at once.

    Nothing will ever set the event, so waiting out the full budget before
    looking at the future would delay the diagnosis by exactly that long.
    """
    monkeypatch.setattr(sys, 'argv', ['node.py', '--data_port=12345'])
    # Generous on purpose: the point of the test is that it is not spent.
    monkeypatch.setattr(node, '_SHARED_SERVER_STARTUP_TIMEOUT_SECONDS', 30.0)

    future = MagicMock(name='future')
    future.done.return_value = True
    future.result.side_effect = RuntimeError('lifespan startup failed')

    def fake_web_server(config=None, on_startup=None, **kwargs):
        # Never fire on_startup: the failure precedes it.
        return MagicMock(name='WebServer-instance')

    monkeypatch.setattr('ai.web.WebServer', fake_web_server)
    monkeypatch.setattr('asyncio.run_coroutine_threadsafe', lambda coro, loop: future)

    started_at = time.monotonic()
    with pytest.raises(RuntimeError, match='lifespan startup failed'):
        node._setup_shared_web_server()
    elapsed = time.monotonic() - started_at

    assert elapsed < 5.0, f'should not have waited out the 30s budget; took {elapsed:.1f}s'


def test_setup_reports_a_server_that_stopped_before_listening(monkeypatch):
    """``serve()`` ending cleanly during startup must not return in silence.

    It raises nothing, so the fail-fast branch has nothing to re-raise — but the
    listener never came up either, and the caller is about to publish a
    ``shared_web_server`` whose ``/task/data`` stays unreachable for the rest of
    the subprocess's life. That is the one path that can hand back a dead server.
    """
    monkeypatch.setattr(sys, 'argv', ['node.py', '--data_host=127.0.0.1', '--data_port=12345'])

    server_instance = MagicMock(name='WebServer-instance')
    server_instance.server.started = False

    # Completed, and completed cleanly: result() returns rather than raising.
    future = MagicMock(name='future')
    future.done.return_value = True
    future.result.return_value = None

    def fake_web_server(config=None, on_startup=None, **kwargs):
        _fire_startup_callback_now(on_startup)
        return server_instance

    monkeypatch.setattr('ai.web.WebServer', fake_web_server)
    monkeypatch.setattr('asyncio.run_coroutine_threadsafe', lambda coro, loop: future)

    warnings = []
    monkeypatch.setattr(node, 'warning', lambda msg, *a, **kw: warnings.append(str(msg)))
    monkeypatch.setattr(node, 'debug', lambda msg, *a, **kw: None)

    node._setup_shared_web_server()

    assert any('stopped before it began listening on 127.0.0.1:12345' in m for m in warnings), (
        f'a cleanly-stopped server must be named, not returned silently; got {warnings!r}'
    )


def test_setup_reports_when_the_listener_never_comes_up(monkeypatch):
    """Startup signalled but no socket bound is its own diagnosis.

    A different fault from "the callback never fired", and the one a reserved or
    occupied port produces, so it must name the endpoint and stay quiet about
    the callback.
    """
    monkeypatch.setattr(sys, 'argv', ['node.py', '--data_host=127.0.0.1', '--data_port=12345'])
    monkeypatch.setattr(node, '_SHARED_SERVER_STARTUP_TIMEOUT_SECONDS', 0.05)

    # A bare MagicMock reports done() truthy and started truthy, which would
    # leave the poll at the future branch and never reach the deadline.
    server_instance = MagicMock(name='WebServer-instance')
    server_instance.server.started = False
    future = MagicMock(name='future')
    future.done.return_value = False

    def fake_web_server(config=None, on_startup=None, **kwargs):
        _fire_startup_callback_now(on_startup)
        return server_instance

    monkeypatch.setattr('ai.web.WebServer', fake_web_server)
    monkeypatch.setattr('asyncio.run_coroutine_threadsafe', lambda coro, loop: future)

    warnings = []
    debugs = []
    monkeypatch.setattr(node, 'warning', lambda msg, *a, **kw: warnings.append(str(msg)))
    monkeypatch.setattr(node, 'debug', lambda msg, *a, **kw: debugs.append(str(msg)))

    server, returned_future = node._setup_shared_web_server()

    assert server is not None
    assert returned_future is not None
    # A warning, not a debug: engLib's debug() is gated on the DebugOut level,
    # which is off by default, so a failure routed through it would be invisible
    # exactly when it matters.
    assert any('never began listening on 127.0.0.1:12345' in m for m in warnings), (
        f'expected the listener case named as a warning; got {warnings!r}'
    )
    assert not any('did not signal' in m for m in debugs), (
        f'callback did fire, so the not-signalled line must stay quiet; got {debugs!r}'
    )


def test_setup_is_quiet_when_the_listener_comes_up(monkeypatch):
    """A healthy startup logs nothing — the control for the test above."""
    monkeypatch.setattr(sys, 'argv', ['node.py', '--data_host=127.0.0.1', '--data_port=12345'])
    monkeypatch.setattr(node, '_SHARED_SERVER_STARTUP_TIMEOUT_SECONDS', 0.5)

    server_instance = MagicMock(name='WebServer-instance')
    server_instance.server.started = True
    future = MagicMock(name='future')
    future.done.return_value = False

    def fake_web_server(config=None, on_startup=None, **kwargs):
        _fire_startup_callback_now(on_startup)
        return server_instance

    monkeypatch.setattr('ai.web.WebServer', fake_web_server)
    monkeypatch.setattr('asyncio.run_coroutine_threadsafe', lambda coro, loop: future)

    messages = []
    monkeypatch.setattr(node, 'debug', lambda msg, *a, **kw: messages.append(str(msg)))
    monkeypatch.setattr(node, 'warning', lambda msg, *a, **kw: messages.append(str(msg)))

    node._setup_shared_web_server()

    assert messages == [], f'a healthy startup should be silent; got {messages!r}'


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


# ---------------------------------------------------------------------------
# require_shared_web_server — the guard source nodes call
# ---------------------------------------------------------------------------


def test_require_returns_the_shared_server_when_set(monkeypatch):
    """Happy path (EaaS): the guard hands back the server untouched."""
    server = MagicMock(name='server')
    monkeypatch.setattr(node, 'shared_web_server', server)

    assert node.require_shared_web_server('webhook') is server


def test_require_raises_named_error_when_no_shared_server(monkeypatch):
    """No server → RuntimeError naming the node and --data_port, never AttributeError.

    Without this guard the caller does `node.shared_web_server.app.state.target = ...`
    and the pipeline dies with "'NoneType' object has no attribute 'app'" raised
    out of scanObjects, which names neither the cause nor the fix.
    """
    monkeypatch.setattr(node, 'shared_web_server', None)

    with pytest.raises(RuntimeError, match='data_port'):
        node.require_shared_web_server('webhook')


def test_require_error_names_the_calling_node(monkeypatch):
    """The node name reaches the message, so the log says which source failed."""
    monkeypatch.setattr(node, 'shared_web_server', None)

    with pytest.raises(RuntimeError, match='dropper'):
        node.require_shared_web_server('dropper')
