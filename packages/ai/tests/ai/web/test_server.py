"""Tests for ALLOWED_MODULES allowlist and WebServer.use() validation."""

import os
import signal
import socket
import sys
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

# ---------------------------------------------------------------------------
# Mock heavy third-party / internal dependencies that WebServer.__init__
# pulls in so we can import the module without a full runtime environment.
# ---------------------------------------------------------------------------

_INJECTED_MODULES: list[str] = []
_ORIGINAL_AI_WEB_SERVER = sys.modules.get('ai.web.server')


def _inject(name: str, module: object) -> None:
    """Insert *module* into sys.modules under *name* if absent, tracking it."""
    if name not in sys.modules:
        sys.modules[name] = module  # type: ignore[assignment]
        _INJECTED_MODULES.append(name)


# rocketride constants
_mock_rocketride = MagicMock()
_mock_rocketride.CONST_WS_PING_INTERVAL = 20
_mock_rocketride.CONST_WS_PING_TIMEOUT = 20
_inject('rocketride', _mock_rocketride)

# depends (used transitively by ai.web.__init__)
_inject('depends', MagicMock())

# rocketlib (server.py imports debug; real module needs the engine's engLib)
_inject('rocketlib', MagicMock())

# ai.account and its sub-modules (ai.web.__init__ imports ai.account.account)
_mock_ai_account = MagicMock()
_inject('ai.account', _mock_ai_account)
_inject('ai.account.account', _mock_ai_account)

# ai.web.response (ai.web.__init__ imports from ai.web.response)
_inject('ai.web.response', MagicMock())

# ai.web.middleware
_inject('ai.web.middleware', MagicMock())

# ai.web.endpoints — provide attribute stubs the import line expects
_mock_endpoints = MagicMock()
for _name in ('use', 'ping', 'version', 'shutdown', 'status'):
    setattr(_mock_endpoints, _name, MagicMock())
_inject('ai.web.endpoints', _mock_endpoints)

# ai.web.denied (server.py imports from .denied)
_inject('ai.web.denied', MagicMock())

# ai.constants
_mock_constants = MagicMock()
_mock_constants.CONST_DEFAULT_WEB_PORT = 5565
_mock_constants.CONST_DEFAULT_WEB_HOST = '127.0.0.1'
_mock_constants.CONST_WEB_WS_MAX_SIZE = 16 * 1024 * 1024
_inject('ai.constants', _mock_constants)

# dotenv
_inject('dotenv', MagicMock())

# uvicorn
_inject('uvicorn', MagicMock())

# Now we can safely import the module under test
from ai.web.server import WebServer, _build_signal_safe_capture
from ai.modules import ALL as ALLOWED_MODULES


def teardown_module() -> None:
    """Remove injected mocks from sys.modules to avoid leaking into other tests."""
    for name in _INJECTED_MODULES:
        sys.modules.pop(name, None)
    _INJECTED_MODULES.clear()
    if _ORIGINAL_AI_WEB_SERVER is None:
        sys.modules.pop('ai.web.server', None)
    else:
        sys.modules['ai.web.server'] = _ORIGINAL_AI_WEB_SERVER


# ============================================================================
# ALLOWED_MODULES constant tests
# ============================================================================


class TestAllowedModules:
    """Verify the ALLOWED_MODULES constant is correct and immutable."""

    def test_allowed_modules_is_frozenset(self):
        assert isinstance(ALLOWED_MODULES, frozenset)

    def test_allowed_modules_contains_expected_entries(self):
        expected = {
            'chat',
            'clients',
            'data',
            'dropper',
            'pipe',
            'remote',
            'services',
            'shell',
            'task',
            'task_http',
        }
        assert expected == ALLOWED_MODULES


# ============================================================================
# WebServer.use() tests
# ============================================================================


def _make_server() -> WebServer:
    """Build a minimal WebServer-like object suitable for testing use()."""
    server = object.__new__(WebServer)
    server.app = SimpleNamespace(state=SimpleNamespace(modules={}))
    return server


class TestUseMethod:
    """Verify that WebServer.use() enforces the allowlist."""

    def test_use_rejects_non_allowlisted_module(self):
        server = _make_server()
        with pytest.raises(ValueError, match='not allowed'):
            server.use('malicious_module')

    def test_use_rejects_path_traversal_attempt(self):
        server = _make_server()
        with pytest.raises(ValueError, match='not allowed'):
            server.use('../../etc/passwd')

    @patch('ai.web.server.importlib.import_module')
    def test_use_accepts_valid_allowlisted_module(self, mock_import):
        mock_module = MagicMock()
        mock_import.return_value = mock_module

        server = _make_server()
        server.use('chat')

        mock_import.assert_called_once_with('ai.modules.chat')
        mock_module.initModule.assert_called_once_with(server, {})

    @patch('ai.web.server.importlib.import_module')
    def test_use_normalizes_module_name(self, mock_import):
        mock_module = MagicMock()
        mock_import.return_value = mock_module

        server = _make_server()
        server.use('  CHAT  ')

        mock_import.assert_called_once_with('ai.modules.chat')

    @patch('ai.web.server.importlib.import_module')
    def test_use_does_not_reload_already_loaded_module(self, mock_import):
        server = _make_server()
        cached_module = MagicMock(initModule=MagicMock())
        server.app.state.modules['chat'] = cached_module

        server.use('chat')

        mock_import.assert_not_called()
        cached_module.initModule.assert_not_called()


class TestSignalCapture:
    """Verify Uvicorn shutdown signal restoration is tolerant of embedded runtimes."""

    def test_capture_signals_skips_unrestorable_previous_handler(self, monkeypatch):
        import ai.web.server as server_module

        handled_signal = signal.SIGTERM
        fake_server = SimpleNamespace(handle_exit=MagicMock(), _captured_signals=[])
        calls = []

        server_module.uvicorn.server.HANDLED_SIGNALS = [handled_signal]

        def fake_signal(sig, handler):
            calls.append((sig, handler))
            if handler is fake_server.handle_exit:
                return None
            if handler is None:
                raise TypeError('signal handler must be signal.SIG_IGN, signal.SIG_DFL, or a callable object')
            return signal.SIG_DFL

        monkeypatch.setattr(server_module.signal, 'signal', fake_signal)
        monkeypatch.setattr(server_module.signal, 'raise_signal', MagicMock())

        capture_signals = _build_signal_safe_capture(fake_server)

        with capture_signals():
            pass

        assert calls == [(handled_signal, fake_server.handle_exit)]


# ============================================================================
# RR_SIGNING_KEY auto-provisioning tests
# ============================================================================


class TestEnsureSigningKey:
    """The server self-provisions an ephemeral RR_SIGNING_KEY when unset."""

    def test_generates_key_when_unset(self, monkeypatch):
        from ai.web.server import _ensure_signing_key

        monkeypatch.delenv('RR_SIGNING_KEY', raising=False)
        monkeypatch.delenv('RR_STORE_URL', raising=False)
        _ensure_signing_key()
        key = os.environ.get('RR_SIGNING_KEY', '')
        assert len(key) == 64
        int(key, 16)  # 32 random bytes, hex-encoded

    def test_respects_operator_provided_key(self, monkeypatch):
        from ai.web.server import _ensure_signing_key

        monkeypatch.setenv('RR_SIGNING_KEY', 'operator-key')
        _ensure_signing_key()
        assert os.environ['RR_SIGNING_KEY'] == 'operator-key'

    def test_idempotent_across_calls(self, monkeypatch):
        from ai.web.server import _ensure_signing_key

        monkeypatch.delenv('RR_SIGNING_KEY', raising=False)
        monkeypatch.delenv('RR_STORE_URL', raising=False)
        _ensure_signing_key()
        first = os.environ['RR_SIGNING_KEY']
        _ensure_signing_key()
        assert os.environ['RR_SIGNING_KEY'] == first

    def test_skips_provision_on_non_filesystem_backend(self, monkeypatch):
        # Cloud/object backends presign natively and never read the key; a
        # deployment that left RR_SIGNING_KEY unset keeps signed fetch URLs
        # switched off, exactly as before self-provisioning existed.
        from ai.web.server import _ensure_signing_key

        monkeypatch.delenv('RR_SIGNING_KEY', raising=False)
        monkeypatch.setenv('RR_STORE_URL', 's3://bucket/prefix')
        _ensure_signing_key()
        assert os.environ.get('RR_SIGNING_KEY') is None

    def test_provisions_on_explicit_filesystem_backend(self, monkeypatch):
        from ai.web.server import _ensure_signing_key

        monkeypatch.delenv('RR_SIGNING_KEY', raising=False)
        monkeypatch.setenv('RR_STORE_URL', 'filesystem:///tmp/store')
        _ensure_signing_key()
        assert len(os.environ.get('RR_SIGNING_KEY', '')) == 64


# ============================================================================
# WebServer.get_port() tests — see #994
# ============================================================================


def _bind_ipv4() -> socket.socket:
    """Bind a real IPv4 socket to an OS-assigned ephemeral port."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.bind(('127.0.0.1', 0))
    return sock


def _bind_ipv6() -> socket.socket:
    """Bind a real IPv6 socket to an OS-assigned ephemeral port, or skip.

    ``socket.has_ipv6`` only reports build-time support, not whether this
    host can actually bind the IPv6 loopback (many CI runners can't) — so
    the bind itself, not just the flag, decides whether to skip.
    """
    if not socket.has_ipv6:
        pytest.skip('platform built without IPv6 support')
    sock = socket.socket(socket.AF_INET6, socket.SOCK_STREAM)
    try:
        sock.bind(('::1', 0))
    except OSError as exc:
        sock.close()
        pytest.skip(f'cannot bind IPv6 loopback: {exc}')
    return sock


def _make_port_server() -> WebServer:
    """Build a minimal WebServer-like object suitable for get_port() tests."""
    server = object.__new__(WebServer)
    server._port = 0
    server.server = None
    server._base_url_scheme = 'http'
    server._base_url_host = 'localhost'
    return server


def _stub_uvicorn_server(*sockets: socket.socket) -> SimpleNamespace:
    """Minimal stand-in for uvicorn's server object: server.servers[*].sockets."""
    return SimpleNamespace(servers=[SimpleNamespace(sockets=list(sockets))])


class TestGetPort:
    """Verify get_port() prefers a bound IPv4 socket over IPv6. See #994."""

    def test_dual_stack_prefers_ipv4(self, monkeypatch):
        """On a dual-stack host, get_port() returns the IPv4 port even when IPv6 is listed first."""
        monkeypatch.delenv('RR_BASE_URL', raising=False)
        ipv4 = _bind_ipv4()
        ipv6 = _bind_ipv6()
        try:
            ipv4_port = ipv4.getsockname()[1]
            ipv6_port = ipv6.getsockname()[1]
            if ipv4_port == ipv6_port:
                pytest.skip('kernel assigned the same port to both families; preference is unobservable')

            server = _make_port_server()
            # IPv6 listed first — the test proves nothing if IPv4 wins by position alone.
            server.server = _stub_uvicorn_server(ipv6, ipv4)

            assert server.get_port() == ipv4_port
        finally:
            ipv4.close()
            ipv6.close()

    def test_ipv6_only_falls_back(self, monkeypatch):
        """With no IPv4 socket bound, get_port() falls back to the IPv6 port."""
        monkeypatch.delenv('RR_BASE_URL', raising=False)
        ipv6 = _bind_ipv6()
        try:
            ipv6_port = ipv6.getsockname()[1]

            server = _make_port_server()
            server.server = _stub_uvicorn_server(ipv6)

            assert server.get_port() == ipv6_port
        finally:
            ipv6.close()

    def test_rr_base_url_behaviour(self, monkeypatch):
        """RR_BASE_URL is published from the resolved port only when unset."""
        ipv4 = _bind_ipv4()
        try:
            ipv4_port = ipv4.getsockname()[1]

            monkeypatch.delenv('RR_BASE_URL', raising=False)
            server = _make_port_server()
            server.server = _stub_uvicorn_server(ipv4)
            server.get_port()
            assert os.environ['RR_BASE_URL'] == f'http://localhost:{ipv4_port}'

            monkeypatch.setenv('RR_BASE_URL', 'sentinel-value')
            other_server = _make_port_server()
            other_server.server = _stub_uvicorn_server(ipv4)
            other_server.get_port()
            assert os.environ['RR_BASE_URL'] == 'sentinel-value'
        finally:
            ipv4.close()
