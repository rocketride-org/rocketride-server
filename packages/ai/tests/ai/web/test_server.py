"""Tests for ALLOWED_MODULES allowlist and WebServer.use() validation."""

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
from ai.web.server import WebServer
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
            'profiler',
            'remote',
            'services',
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
