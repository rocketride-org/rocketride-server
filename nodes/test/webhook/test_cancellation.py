# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Exercise the source's cancellation wait without an embedded engine or vendors."""

import importlib.util
import sys
import threading
from pathlib import Path
from types import ModuleType, SimpleNamespace
from unittest.mock import Mock, patch

import pytest


@pytest.fixture
def source_module(monkeypatch):
    """Load the real source with only its native and server boundaries stubbed."""
    rocketlib = ModuleType('rocketlib')
    rocketlib.IEndpointBase = object
    rocketlib.monitorOther = Mock()
    rocketlib.monitorStatus = Mock()
    rocketlib.debug = Mock()
    rocketlib.isCancelled = Mock(return_value=False)
    depends = ModuleType('depends')
    depends.depends = Mock()
    ai = ModuleType('ai')
    ai.node = SimpleNamespace(require_shared_web_server=Mock())
    monkeypatch.setitem(sys.modules, 'rocketlib', rocketlib)
    monkeypatch.setitem(sys.modules, 'depends', depends)
    monkeypatch.setitem(sys.modules, 'ai', ai)
    path = Path(__file__).resolve().parents[2] / 'src/nodes/webhook/IEndpoint.py'
    spec = importlib.util.spec_from_file_location('_webhook_cancel_test', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.mark.parametrize('logical_type', ['chat', 'webhook', 'dropper', 'tools', 'adtoolchain'])
def test_idle_source_returns_on_engine_cancellation(source_module, logical_type):
    """A source receiving no objects must leave scanObjects before the 5s kill."""
    endpoint = source_module.IEndpoint()
    endpoint.endpoint = SimpleNamespace(logicalType=logical_type, target=object())
    ready = threading.Event()
    cancelled = threading.Event()
    endpoint._startup = ready.set
    endpoint._shutdown = Mock()
    source_module.isCancelled.side_effect = cancelled.is_set
    callback = Mock()
    errors = []

    def scan():
        try:
            endpoint.scanObjects('', callback)
        except BaseException as error:
            errors.append(error)

    thread = threading.Thread(target=scan, daemon=True)
    thread.start()
    try:
        assert ready.wait(timeout=1)
        assert thread.is_alive(), 'Source exited before cancellation'
        cancelled.set()
        thread.join(timeout=1)
        assert not thread.is_alive(), 'Source ignored engine cancellation'
        assert errors == []
        endpoint._shutdown.assert_called_once_with()
        callback.assert_not_called()
    finally:
        # Release the old implementation too, so a regression cannot leak a thread.
        if hasattr(endpoint, '_shutdown_event'):
            endpoint._shutdown_event.set()
        thread.join(timeout=1)


def test_already_cancelled_source_does_not_wait(source_module):
    """Cancellation before scan startup must bypass the blocking wait."""
    endpoint = source_module.IEndpoint()
    endpoint.endpoint = SimpleNamespace(logicalType='chat')
    endpoint._startup = Mock()
    endpoint._shutdown = Mock()
    source_module.isCancelled.return_value = True
    event = Mock()
    with patch.object(source_module.threading, 'Event', return_value=event):
        endpoint._run()
    event.wait.assert_not_called()
    endpoint._shutdown.assert_called_once_with()


def test_shutdown_metadata_is_cleared_when_wait_fails(source_module, monkeypatch):
    """A wait failure must clear the source metadata before propagating."""
    endpoint = source_module.IEndpoint()
    endpoint.endpoint = SimpleNamespace(logicalType='webhook')
    endpoint._startup = Mock()
    endpoint._shutdown = Mock()
    event = Mock()
    event.wait.side_effect = RuntimeError('wait failed')
    monkeypatch.setattr(source_module.threading, 'Event', lambda: event)
    with pytest.raises(RuntimeError, match='wait failed'):
        endpoint._run()
    endpoint._shutdown.assert_called_once_with()
