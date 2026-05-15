# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Unit tests for webhook IEndpoint._run() — discovery + shutdown contract.

Pins the contract introduced when the source node stopped owning its own
WebServer and started reusing the shared one bootstrapped by node.py:

- With `ai.node.shared_web_server` set: `_run()` registers
  `shared.app.state.target = self.target`, drives `_startup` manually,
  and blocks on `self._shutdown_event` until signalled.
- With `ai.node.shared_web_server` is None: `_run()` falls back to the
  legacy `_run_legacy_self_hosted_server()` path (today's behavior —
  constructs its own WebServer and calls .run()).
"""

import sys
import threading
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

NODES_SRC = Path(__file__).parent.parent.parent / 'src' / 'nodes'
if str(NODES_SRC) not in sys.path:
    sys.path.insert(0, str(NODES_SRC))

from webhook.IEndpoint import IEndpoint  # noqa: E402


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_endpoint():
    """Build a webhook IEndpoint with the minimum surface needed for _run() tests.

    Bypasses __init__ via __new__ so we don't drag in C-engine dependencies.
    Sets `self.target` to a sentinel mock and `self.endpoint` to a minimal
    stand-in that satisfies the lifespan hooks.
    """
    ep = IEndpoint.__new__(IEndpoint)
    ep.target = MagicMock(name='target-endpoint')
    ep.endpoint = MagicMock(name='endpoint')
    ep.endpoint.logicalType = 'webhook'
    return ep


def _shared_server_mock():
    """A shared WebServer mock with the attribute surface webhook touches."""
    shared = MagicMock(name='shared-WebServer')
    shared.app.state = MagicMock(name='app.state')
    return shared


# ---------------------------------------------------------------------------
# Shared-server path: discovery + registration
# ---------------------------------------------------------------------------


def test_run_uses_shared_server_when_available_and_sets_target():
    """When ai.node.shared_web_server is set, _run() writes state.target = self.target."""
    ep = _make_endpoint()
    shared = _shared_server_mock()

    # Set the shutdown event in advance so .wait() returns immediately.
    # The actual event is created inside _run(), so we patch threading.Event
    # to give us a pre-set one.
    pre_set_event = threading.Event()
    pre_set_event.set()

    with (
        patch('ai.node.shared_web_server', shared),
        patch('webhook.IEndpoint.threading.Event', return_value=pre_set_event),
        patch.object(IEndpoint, '_emit_ready_status_sync'),
        patch.object(IEndpoint, '_emit_shutdown_status_sync'),
    ):
        ep._run()

    # target was registered on the shared server
    assert shared.app.state.target is ep.target


def test_run_does_not_construct_a_new_WebServer_when_shared_is_available():
    """The whole point of the refactor: shared-server path never builds its own."""
    ep = _make_endpoint()
    shared = _shared_server_mock()

    pre_set_event = threading.Event()
    pre_set_event.set()

    with (
        patch('ai.node.shared_web_server', shared),
        patch('webhook.IEndpoint.threading.Event', return_value=pre_set_event),
        patch.object(IEndpoint, '_emit_ready_status_sync'),
        patch.object(IEndpoint, '_emit_shutdown_status_sync'),
        patch('webhook.IEndpoint.WebServer') as web_server_cls,
    ):
        ep._run()

    # WebServer constructor was never called.
    web_server_cls.assert_not_called()


def test_run_does_not_call_use_data_when_shared_server_is_used():
    """Shared server already has /task/data registered eagerly by node.py."""
    ep = _make_endpoint()
    shared = _shared_server_mock()

    pre_set_event = threading.Event()
    pre_set_event.set()

    with (
        patch('ai.node.shared_web_server', shared),
        patch('webhook.IEndpoint.threading.Event', return_value=pre_set_event),
        patch.object(IEndpoint, '_emit_ready_status_sync'),
        patch.object(IEndpoint, '_emit_shutdown_status_sync'),
    ):
        ep._run()

    # Confirm webhook did NOT call .use(...) on the shared server.
    shared.use.assert_not_called()


def test_run_blocks_until_shutdown_event_is_set():
    """_run() must not return until self._shutdown_event is set."""
    ep = _make_endpoint()
    shared = _shared_server_mock()

    # Use a real Event so we can control timing.
    real_event = threading.Event()
    returned = []

    def call_run():
        with (
            patch('ai.node.shared_web_server', shared),
            patch('webhook.IEndpoint.threading.Event', return_value=real_event),
            patch.object(IEndpoint, '_emit_ready_status_sync'),
            patch.object(IEndpoint, '_emit_shutdown_status_sync'),
        ):
            ep._run()
        returned.append('done')

    t = threading.Thread(target=call_run, daemon=True)
    t.start()

    # Give _run() a moment to enter wait(); it must NOT have returned.
    t.join(timeout=0.2)
    assert returned == [], '_run() returned before _shutdown_event was set'

    # Now release.
    real_event.set()
    t.join(timeout=2.0)
    assert returned == ['done'], '_run() did not return after _shutdown_event was set'


def test_run_drives_startup_and_shutdown_sync_helpers():
    """The shared-server path calls _emit_ready_status_sync and _emit_shutdown_status_sync."""
    ep = _make_endpoint()
    shared = _shared_server_mock()

    pre_set_event = threading.Event()
    pre_set_event.set()

    with (
        patch('ai.node.shared_web_server', shared),
        patch('webhook.IEndpoint.threading.Event', return_value=pre_set_event),
        patch.object(IEndpoint, '_emit_ready_status_sync') as ready_mock,
        patch.object(IEndpoint, '_emit_shutdown_status_sync') as shutdown_mock,
    ):
        ep._run()

    ready_mock.assert_called_once()
    shutdown_mock.assert_called_once()


def test_run_exposes_shutdown_event_for_external_signaling():
    """After _run() enters wait, `self._shutdown_event` is exposed as an attribute."""
    ep = _make_endpoint()
    shared = _shared_server_mock()
    real_event = threading.Event()

    def call_run():
        with (
            patch('ai.node.shared_web_server', shared),
            patch('webhook.IEndpoint.threading.Event', return_value=real_event),
            patch.object(IEndpoint, '_emit_ready_status_sync'),
            patch.object(IEndpoint, '_emit_shutdown_status_sync'),
        ):
            ep._run()

    t = threading.Thread(target=call_run, daemon=True)
    t.start()

    # Wait briefly for _run() to reach the wait() call and set _shutdown_event.
    # The exact timing of attribute assignment vs. .wait() entry is fine
    # because attribute assignment happens before .wait() in the source.
    import time

    for _ in range(20):
        if hasattr(ep, '_shutdown_event'):
            break
        time.sleep(0.01)

    assert hasattr(ep, '_shutdown_event'), '_run() did not set _shutdown_event attribute'
    assert ep._shutdown_event is real_event

    # Release so the thread exits cleanly.
    real_event.set()
    t.join(timeout=2.0)


# ---------------------------------------------------------------------------
# Legacy fallback: shared server is None
# ---------------------------------------------------------------------------


def test_run_falls_back_to_legacy_when_shared_server_is_None():
    """With ai.node.shared_web_server=None, _run() delegates to the legacy path."""
    ep = _make_endpoint()

    with patch('ai.node.shared_web_server', None), patch.object(ep, '_run_legacy_self_hosted_server') as legacy:
        ep._run()

    legacy.assert_called_once()


def test_legacy_path_constructs_own_WebServer_and_calls_run():
    """The legacy fallback preserves today's behavior — own server, .run() blocking."""
    ep = _make_endpoint()

    mock_server_instance = MagicMock(name='WebServer-instance')
    mock_server_instance.app.state = MagicMock()

    with (
        patch('webhook.IEndpoint.WebServer', return_value=mock_server_instance) as web_server_cls,
        patch.object(sys, 'argv', ['node.py']),
    ):
        ep._run_legacy_self_hosted_server()

    # WebServer was constructed
    web_server_cls.assert_called_once()
    # .use('data') was called
    mock_server_instance.use.assert_called_once_with('data')
    # .run() was called (blocking — but mocked, so returns immediately)
    mock_server_instance.run.assert_called_once()
    # target was assigned
    assert mock_server_instance.app.state.target is ep.target


# ---------------------------------------------------------------------------
# Exception robustness in shared-server path
# ---------------------------------------------------------------------------


def test_run_startup_failure_does_not_block_main_path():
    """A failure in _emit_ready_status_sync is caught by its own try/except (not _run's concern)."""
    ep = _make_endpoint()
    shared = _shared_server_mock()
    pre_set_event = threading.Event()
    pre_set_event.set()

    # _emit_ready_status_sync swallows exceptions internally (see implementation
    # in webhook.IEndpoint). Even if its body raises, the helper returns
    # cleanly so _run() proceeds to the wait().
    with (
        patch('ai.node.shared_web_server', shared),
        patch('webhook.IEndpoint.threading.Event', return_value=pre_set_event),
        patch.object(IEndpoint, '_emit_ready_status_sync', side_effect=RuntimeError('startup boom')),
        patch.object(IEndpoint, '_emit_shutdown_status_sync'),
    ):
        # _emit_ready_status_sync raising at the call site DOES propagate
        # because the sync helper's try/except is inside the helper body
        # (which we've mocked away). In practice this can't happen — the
        # real helper catches its own exceptions — but assert _run()'s
        # contract: it does not add another layer of try/except, so a
        # patched-to-raise helper does propagate.
        with pytest.raises(RuntimeError, match='startup boom'):
            ep._run()
