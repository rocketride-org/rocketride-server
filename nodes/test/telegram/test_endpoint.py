# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Unit tests for telegram IEndpoint._run() — dual-mode shared-server contract.

Pins the contract for the source node's two delivery modes:

- Webhook mode: register `/telegram/webhook` POST route on the shared
  server; set state.target; drive _startup; block on shutdown event.
- Polling mode: don't register an HTTP route; set state.target; drive
  _startup (which spawns the polling background task); block on
  shutdown event.

Both modes: NOT constructing a new WebServer, NOT calling .use('data')
(the shared server's `data` module is eager-loaded by node.py).
"""

import asyncio
import sys
import threading
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

NODES_SRC = Path(__file__).parent.parent.parent / 'src' / 'nodes'
if str(NODES_SRC) not in sys.path:
    sys.path.insert(0, str(NODES_SRC))


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_endpoint(mode: str = 'polling', webhook_url: str = ''):
    """Build a telegram IEndpoint bypassing __init__.

    Patches ``_get_telegram_config`` so we control mode / token / URL
    without touching the engine's serviceConfig machinery.
    """
    from telegram.IEndpoint import IEndpoint  # noqa: E402

    ep = IEndpoint.__new__(IEndpoint)
    ep.target = MagicMock(name='target-endpoint')
    ep.endpoint = MagicMock(name='endpoint')
    ep._get_telegram_config = MagicMock(
        return_value={
            'botToken': 'test-token-abcdef',
            'mode': mode,
            'webhookUrl': webhook_url,
        }
    )
    # Webhook handler stub so add_route() captures it without error.
    ep._webhook_handler = MagicMock(name='_webhook_handler')
    return ep


def _shared_server_mock():
    """A shared WebServer mock with the attribute surface telegram touches."""
    shared = MagicMock(name='shared-WebServer')
    shared.app.state = MagicMock(name='app.state')
    return shared


def _make_awaitable(value):
    """Wrap a plain value in an already-resolved awaitable.

    Used to stub `async def` methods (e.g. `_setup_webhook`) on a MagicMock
    so `await ep._setup_webhook()` resolves to the chosen value without
    spinning up a real coroutine.
    """

    async def _coro():
        return value

    return _coro()


# ---------------------------------------------------------------------------
# Shared-server path: WEBHOOK mode
# ---------------------------------------------------------------------------


def test_webhook_mode_registers_add_route_on_shared_server():
    """Webhook mode adds the /telegram/webhook POST route to the shared server."""
    ep = _make_endpoint(mode='webhook', webhook_url='https://example.com/telegram/webhook')
    shared = _shared_server_mock()
    pre_set_event = threading.Event()
    pre_set_event.set()

    with (
        patch('ai.node.shared_web_server', shared),
        patch('telegram.IEndpoint.threading.Event', return_value=pre_set_event),
        patch(
            'telegram.IEndpoint.asyncio.run_coroutine_threadsafe',
            return_value=MagicMock(result=MagicMock(return_value=None)),
        ),
    ):
        ep._run()

    # add_route called exactly once with the path from the configured URL.
    shared.add_route.assert_called_once()
    call_args = shared.add_route.call_args
    assert call_args.args[0] == '/telegram/webhook'
    # public=True for Telegram's POSTs (no auth header)
    assert call_args.kwargs.get('public') is True or (len(call_args.args) >= 4 and call_args.args[3] is True)


def test_webhook_mode_defaults_path_when_webhook_url_is_empty():
    """An empty webhookUrl falls back to the default /telegram/webhook path."""
    ep = _make_endpoint(mode='webhook', webhook_url='')
    shared = _shared_server_mock()
    pre_set_event = threading.Event()
    pre_set_event.set()

    with (
        patch('ai.node.shared_web_server', shared),
        patch('telegram.IEndpoint.threading.Event', return_value=pre_set_event),
        patch(
            'telegram.IEndpoint.asyncio.run_coroutine_threadsafe',
            return_value=MagicMock(result=MagicMock(return_value=None)),
        ),
    ):
        ep._run()

    assert shared.add_route.call_args.args[0] == '/telegram/webhook'


def test_webhook_mode_sets_target_on_shared_server():
    """Webhook mode writes state.target = self.target."""
    ep = _make_endpoint(mode='webhook', webhook_url='https://example.com/telegram/webhook')
    shared = _shared_server_mock()
    pre_set_event = threading.Event()
    pre_set_event.set()

    with (
        patch('ai.node.shared_web_server', shared),
        patch('telegram.IEndpoint.threading.Event', return_value=pre_set_event),
        patch(
            'telegram.IEndpoint.asyncio.run_coroutine_threadsafe',
            return_value=MagicMock(result=MagicMock(return_value=None)),
        ),
    ):
        ep._run()

    assert shared.app.state.target is ep.target


# ---------------------------------------------------------------------------
# Shared-server path: POLLING mode
# ---------------------------------------------------------------------------


def test_polling_mode_does_not_call_add_route():
    """Polling mode is outbound only — no HTTP route registration."""
    ep = _make_endpoint(mode='polling')
    shared = _shared_server_mock()
    pre_set_event = threading.Event()
    pre_set_event.set()

    with (
        patch('ai.node.shared_web_server', shared),
        patch('telegram.IEndpoint.threading.Event', return_value=pre_set_event),
        patch(
            'telegram.IEndpoint.asyncio.run_coroutine_threadsafe',
            return_value=MagicMock(result=MagicMock(return_value=None)),
        ),
    ):
        ep._run()

    shared.add_route.assert_not_called()


def test_polling_mode_sets_target_on_shared_server():
    """Polling mode still sets state.target so data flows route correctly."""
    ep = _make_endpoint(mode='polling')
    shared = _shared_server_mock()
    pre_set_event = threading.Event()
    pre_set_event.set()

    with (
        patch('ai.node.shared_web_server', shared),
        patch('telegram.IEndpoint.threading.Event', return_value=pre_set_event),
        patch(
            'telegram.IEndpoint.asyncio.run_coroutine_threadsafe',
            return_value=MagicMock(result=MagicMock(return_value=None)),
        ),
    ):
        ep._run()

    assert shared.app.state.target is ep.target


# ---------------------------------------------------------------------------
# Shared-server path: blocking + lifespan
# ---------------------------------------------------------------------------


def test_run_blocks_until_shutdown_event_in_polling_mode():
    """_run() must not return until self._shutdown_event is set (polling mode)."""
    ep = _make_endpoint(mode='polling')
    shared = _shared_server_mock()
    real_event = threading.Event()
    returned = []

    def call_run():
        with (
            patch('ai.node.shared_web_server', shared),
            patch('telegram.IEndpoint.threading.Event', return_value=real_event),
            patch(
                'telegram.IEndpoint.asyncio.run_coroutine_threadsafe',
                return_value=MagicMock(result=MagicMock(return_value=None)),
            ),
        ):
            ep._run()
        returned.append('done')

    t = threading.Thread(target=call_run, daemon=True)
    t.start()
    t.join(timeout=0.2)
    assert returned == [], '_run() returned before _shutdown_event was set'

    real_event.set()
    t.join(timeout=2.0)
    assert returned == ['done']


def test_run_drives_startup_and_shutdown_callbacks_in_shared_path():
    """Lifespan hooks scheduled on server_loop (the shared daemon-thread loop)."""
    ep = _make_endpoint(mode='polling')
    shared = _shared_server_mock()
    pre_set_event = threading.Event()
    pre_set_event.set()

    with (
        patch('ai.node.shared_web_server', shared),
        patch('telegram.IEndpoint.threading.Event', return_value=pre_set_event),
        patch(
            'telegram.IEndpoint.asyncio.run_coroutine_threadsafe',
            return_value=MagicMock(result=MagicMock(return_value=None)),
        ) as schedule_mock,
    ):
        ep._run()

    # Scheduled twice — once for _startup, once for _shutdown — both on server_loop.
    assert schedule_mock.call_count == 2, (
        f'expected run_coroutine_threadsafe to schedule both lifespan hooks; got {schedule_mock.call_count} call(s)'
    )


# ---------------------------------------------------------------------------
# `_startup` soft-fail paths must raise (CodeRabbit review #4313515126)
#
# `_startup()` previously returned normally for fatal startup conditions like
# a missing bot token or a failed webhook registration. That left the source
# thread blocking on `_shutdown_event.wait()` with no active Telegram session
# and no failure surfaced to the engine. These tests pin the new contract:
# fatal startup states raise so `_run`'s existing try/except re-raises out
# of the source-node thread.
# ---------------------------------------------------------------------------


def test_startup_raises_when_bot_token_missing():
    """_startup must raise for the missing-token soft-fail path."""
    ep = _make_endpoint(mode='polling')
    ep._bot_token = ''
    ep._mode = 'polling'
    ep._webhook_url = ''

    with pytest.raises(RuntimeError, match='bot token'):
        asyncio.run(ep._startup())


def test_startup_raises_when_webhook_setup_fails(monkeypatch):
    """_startup must raise when _setup_webhook returns False (webhook mode).

    `_startup` does `import aiohttp` then `aiohttp.ClientSession()` BEFORE
    reaching the webhook check we want to exercise. In production the import
    resolves because `IGlobal.beginGlobal()` ran `depends(requirements.txt)`
    first and pip-installed `aiohttp`. Unit tests bypass that lifecycle, and
    the broader test framework intentionally mocks `depends` to a `MagicMock`
    in `test_contracts.py::mock_engine_libs` — so even calling `beginGlobal`
    from a fixture is a no-op. The test doesn't actually need real aiohttp:
    `_setup_webhook` is stubbed to return False, so the session is never used.
    Stubbing `sys.modules['aiohttp']` for the test's duration lets the
    function reach the webhook-failure branch under test. Same pattern
    `test_contracts.py:579-580` uses for other engine dependencies.
    """
    monkeypatch.setitem(sys.modules, 'aiohttp', MagicMock(name='aiohttp-stub'))

    ep = _make_endpoint(mode='webhook', webhook_url='https://example.com/telegram/webhook')
    ep._bot_token = 'test-token'
    ep._mode = 'webhook'
    ep._webhook_url = 'https://example.com/telegram/webhook'
    ep._setup_webhook = MagicMock(return_value=_make_awaitable(False))

    with pytest.raises(RuntimeError, match='webhook'):
        asyncio.run(ep._startup())
