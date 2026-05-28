# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Unit tests for webhook IEndpoint._run() — shared-server registration contract.

Pins the contract introduced when the source node stopped owning its own
WebServer and started reusing the shared one bootstrapped by node.py:
`_run()` registers `shared.app.state.target = self.target`, drives
`_startup` directly, and blocks on `self._shutdown_event` until signalled.
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
        patch.object(IEndpoint, '_startup'),
        patch.object(IEndpoint, '_shutdown'),
    ):
        ep._run()

    # target was registered on the shared server
    assert shared.app.state.target is ep.target


def test_run_does_not_call_use_data_when_shared_server_is_used():
    """Shared server already has /task/data registered eagerly by node.py."""
    ep = _make_endpoint()
    shared = _shared_server_mock()

    pre_set_event = threading.Event()
    pre_set_event.set()

    with (
        patch('ai.node.shared_web_server', shared),
        patch('webhook.IEndpoint.threading.Event', return_value=pre_set_event),
        patch.object(IEndpoint, '_startup'),
        patch.object(IEndpoint, '_shutdown'),
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
            patch.object(IEndpoint, '_startup'),
            patch.object(IEndpoint, '_shutdown'),
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


def test_run_drives_startup_and_shutdown():
    """The shared-server path calls `_startup` then `_shutdown` once each."""
    ep = _make_endpoint()
    shared = _shared_server_mock()

    pre_set_event = threading.Event()
    pre_set_event.set()

    with (
        patch('ai.node.shared_web_server', shared),
        patch('webhook.IEndpoint.threading.Event', return_value=pre_set_event),
        patch.object(IEndpoint, '_startup') as startup_mock,
        patch.object(IEndpoint, '_shutdown') as shutdown_mock,
    ):
        ep._run()

    startup_mock.assert_called_once()
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
            patch.object(IEndpoint, '_startup'),
            patch.object(IEndpoint, '_shutdown'),
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
# Exception robustness in shared-server path
# ---------------------------------------------------------------------------


def test_run_startup_failure_propagates():
    """`_startup` swallows its own exceptions; if patched to raise, _run does NOT catch."""
    ep = _make_endpoint()
    shared = _shared_server_mock()
    pre_set_event = threading.Event()
    pre_set_event.set()

    # `_startup` swallows exceptions internally (see implementation in
    # webhook.IEndpoint). Even if its body raises, the real method
    # returns cleanly so _run() proceeds to the wait(). Here we mock it
    # to raise — that bypasses the internal try/except, so the exception
    # propagates. `_run()` does NOT add a second layer of try/except.
    with (
        patch('ai.node.shared_web_server', shared),
        patch('webhook.IEndpoint.threading.Event', return_value=pre_set_event),
        patch.object(IEndpoint, '_startup', side_effect=RuntimeError('startup boom')),
        patch.object(IEndpoint, '_shutdown'),
    ):
        with pytest.raises(RuntimeError, match='startup boom'):
            ep._run()
