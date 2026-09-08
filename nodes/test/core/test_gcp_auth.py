"""
Unit tests for the shared GCP credential resolver (core/gcp_auth.py).

Pure logic, no server or live API needed:

    pytest nodes/test/core/test_gcp_auth.py -v
"""

from __future__ import annotations

import importlib
import importlib.util
import sys
import types
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

# core/ is a flat dir of engine-loaded modules (no __init__.py) and nodes/src is
# not on pytest's pythonpath, so import the module by adding its dir to sys.path.
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'src' / 'nodes' / 'core'))
from gcp_auth import GCPAuthError, _DEFAULT_SCOPES, get_gcp_credentials  # noqa: E402

_MISSING = object()

# Slots that this file may load (real SDK or stub). Snapshot all four whether
# or not the helper added them — a real google-auth install is imported in
# place and must still be restored so later suites can resolve
# nodes/test/mocks/google (see tool_google_workspace gmail mock SDK tests).
_GOOGLE_AUTH_MODULES = (
    'google',
    'google.auth',
    'google.oauth2',
    'google.oauth2.service_account',
)


def _cannot_import(name: str) -> bool:
    """True when ``name`` is not already loaded and cannot be found on disk.

    A ``None`` entry in ``sys.modules`` is a failed import, not a loaded module.
    """
    if sys.modules.get(name) is not None:
        return False
    try:
        return importlib.util.find_spec(name) is None
    except (ImportError, ModuleNotFoundError, ValueError):
        return True


def _install_google_auth_stubs() -> tuple[list[str], list[tuple[Any, str, Any]]]:
    """Make ``google.auth`` and ``google.oauth2.service_account`` patchable.

    CI's engine pytest process does not install per-node requirements, so
    google-auth is often missing. ``ROCKETRIDE_MOCK`` also ships ``google.oauth2``
    without ``google.auth``, so ``import google.auth`` fails even when oauth2
    is present.

    Only stub modules that cannot be imported. Do not replace a real
    ``google.auth`` that is installed but not yet loaded, and do not touch
    native modules such as ``google.protobuf`` (unloading those crashes
    Windows workers).
    """
    added: list[str] = []
    attrs: list[tuple[Any, str, Any]] = []

    def _set_attr(parent: Any, name: str, value: Any) -> None:
        attrs.append((parent, name, getattr(parent, name, _MISSING)))
        setattr(parent, name, value)

    google = sys.modules.get('google')
    if google is None:
        if _cannot_import('google'):
            google = types.ModuleType('google')
            google.__path__ = []  # namespace package
            sys.modules['google'] = google
            added.append('google')
        else:
            google = importlib.import_module('google')

    if google is not None and _cannot_import('google.auth'):
        auth = types.ModuleType('google.auth')
        auth.default = MagicMock(side_effect=Exception('Failed to find ADC'))
        sys.modules['google.auth'] = auth
        added.append('google.auth')
        _set_attr(google, 'auth', auth)

    if google is not None and _cannot_import('google.oauth2'):
        oauth2 = types.ModuleType('google.oauth2')
        oauth2.__path__ = []
        sys.modules['google.oauth2'] = oauth2
        added.append('google.oauth2')
        _set_attr(google, 'oauth2', oauth2)

    oauth2 = sys.modules.get('google.oauth2')
    if oauth2 is not None and _cannot_import('google.oauth2.service_account'):
        sa = types.ModuleType('google.oauth2.service_account')

        class Credentials:
            def __init__(self, info=None, scopes=None):
                self.info = info
                self.scopes = scopes

            @classmethod
            def from_service_account_info(cls, info, scopes=None, **kwargs):
                return cls(info=info, scopes=scopes)

            def with_scopes(self, scopes):
                return Credentials(info=self.info, scopes=scopes)

        sa.Credentials = Credentials
        sys.modules['google.oauth2.service_account'] = sa
        added.append('google.oauth2.service_account')
        _set_attr(oauth2, 'service_account', sa)

    return added, attrs


@pytest.fixture(autouse=True)
def _google_auth_stubs():
    """Install stubs when google-auth is missing; restore ``sys.modules`` after.

    ``_install_google_auth_stubs`` only records names it *adds*. On a machine
    where google-auth is installed it imports the real modules instead, and a
    teardown that pops only ``added`` leaves them (and ``google.auth.*`` /
    ``google.oauth2.*`` children) resident. That displaces
    ``nodes/test/mocks/google`` for later suites, and leftover children
    reconstruct a ``google`` namespace without ``auth``.

    ``patch.dict(sys.modules, ..., clear=False)`` snapshots the whole mapping
    and restores it, including those children. Already-loaded
    ``google.protobuf`` stays in the snapshot — unloading it crashes Windows
    workers. The four names are passed explicitly so a pre-existing real or
    mock entry is restored even if this helper never added it.
    """
    saved = {name: sys.modules[name] for name in _GOOGLE_AUTH_MODULES if name in sys.modules}
    with patch.dict(sys.modules, saved, clear=False):
        added, attrs = _install_google_auth_stubs()
        try:
            yield
        finally:
            for parent, name, previous in reversed(attrs):
                if previous is _MISSING:
                    try:
                        delattr(parent, name)
                    except AttributeError:
                        pass
                else:
                    setattr(parent, name, previous)
            for name in reversed(added):
                sys.modules.pop(name, None)


@pytest.fixture(scope='module', autouse=True)
def _google_auth_modules_restored_after_file():
    """Fail this file if any test leaves a real google-auth import behind."""
    before = {name: sys.modules.get(name, _MISSING) for name in _GOOGLE_AUTH_MODULES}
    yield
    after = {name: sys.modules.get(name, _MISSING) for name in _GOOGLE_AUTH_MODULES}
    leaked = [name for name in _GOOGLE_AUTH_MODULES if after[name] is not before[name]]
    assert not leaked, (
        f'test_gcp_auth left google-auth modules resident {leaked}; '
        'sibling suites (tool_google_workspace) expect nodes/test/mocks/google'
    )


def test_get_gcp_credentials_adc_success():
    config = {'authType': 'adc'}
    with patch('google.auth.default') as mock_default:
        mock_creds = MagicMock()
        mock_default.return_value = (mock_creds, 'my-project-id')

        creds, project_id = get_gcp_credentials(config)

        assert creds == mock_creds
        assert project_id == 'my-project-id'
        mock_default.assert_called_once_with(scopes=_DEFAULT_SCOPES)


def test_get_gcp_credentials_adc_explicit_scopes():
    config = {'authType': 'adc'}
    scopes = ['https://www.googleapis.com/auth/datastore']
    with patch('google.auth.default') as mock_default:
        mock_creds = MagicMock()
        mock_default.return_value = (mock_creds, 'my-project-id')

        creds, project_id = get_gcp_credentials(config, scopes=scopes)

        assert creds == mock_creds
        assert project_id == 'my-project-id'
        mock_default.assert_called_once_with(scopes=scopes)


def test_get_gcp_credentials_adc_explicit_project():
    config = {'authType': 'adc', 'projectId': 'explicit-project'}
    with patch('google.auth.default') as mock_default:
        mock_creds = MagicMock()
        mock_default.return_value = (mock_creds, 'my-project-id')

        creds, project_id = get_gcp_credentials(config)

        assert creds == mock_creds
        assert project_id == 'explicit-project'


def test_get_gcp_credentials_adc_failure():
    config = {'authType': 'adc'}
    with patch('google.auth.default', side_effect=Exception('Failed to find ADC')):
        with pytest.raises(GCPAuthError, match='Failed to acquire Application Default Credentials'):
            get_gcp_credentials(config)


def test_get_gcp_credentials_service_account_missing_key():
    config = {'authType': 'service_account'}
    with pytest.raises(GCPAuthError, match='Service Account JSON key is required'):
        get_gcp_credentials(config)


def test_get_gcp_credentials_service_account_invalid_json():
    config = {'authType': 'service_account', 'serviceAccountKey': 'not-a-json'}
    with pytest.raises(GCPAuthError, match='Failed to parse Service Account JSON key'):
        get_gcp_credentials(config)


@patch('google.oauth2.service_account.Credentials.from_service_account_info')
def test_get_gcp_credentials_service_account_success_raw_json(mock_from_info):
    mock_creds = MagicMock()
    mock_scoped = MagicMock()
    mock_creds.with_scopes.return_value = mock_scoped
    mock_from_info.return_value = mock_creds

    config = {
        'authType': 'service_account',
        'serviceAccountKey': '{"project_id": "test-project", "client_email": "test@example.com"}',
    }

    creds, project_id = get_gcp_credentials(config)

    assert creds == mock_scoped
    assert project_id == 'test-project'
    mock_from_info.assert_called_once_with({'project_id': 'test-project', 'client_email': 'test@example.com'})
    mock_creds.with_scopes.assert_called_once_with(_DEFAULT_SCOPES)


@patch('google.oauth2.service_account.Credentials.from_service_account_info')
def test_get_gcp_credentials_service_account_success_data_url(mock_from_info):
    mock_creds = MagicMock()
    mock_scoped = MagicMock()
    mock_creds.with_scopes.return_value = mock_scoped
    mock_from_info.return_value = mock_creds

    # {"project_id": "test-project-b64"} base64 encoded
    b64_json = 'eyJwcm9qZWN0X2lkIjogInRlc3QtcHJvamVjdC1iNjQifQ=='

    config = {'authType': 'service_account', 'serviceAccountKey': f'data:application/json;base64,{b64_json}'}

    creds, project_id = get_gcp_credentials(config)

    assert creds == mock_scoped
    assert project_id == 'test-project-b64'
    mock_from_info.assert_called_once_with({'project_id': 'test-project-b64'})
    mock_creds.with_scopes.assert_called_once_with(_DEFAULT_SCOPES)


@patch('google.oauth2.service_account.Credentials.from_service_account_info')
def test_get_gcp_credentials_service_account_explicit_scopes(mock_from_info):
    mock_creds = MagicMock()
    mock_scoped = MagicMock()
    mock_creds.with_scopes.return_value = mock_scoped
    mock_from_info.return_value = mock_creds

    scopes = ['https://www.googleapis.com/auth/datastore']
    config = {'authType': 'service_account', 'serviceAccountKey': '{"project_id": "test-project"}'}

    creds, project_id = get_gcp_credentials(config, scopes=scopes)

    assert creds == mock_scoped
    assert project_id == 'test-project'
    mock_creds.with_scopes.assert_called_once_with(scopes)


def test_get_gcp_credentials_unknown_auth_type():
    config = {'authType': 'bogus'}
    with pytest.raises(GCPAuthError, match='Unknown authType'):
        get_gcp_credentials(config)


def test_config_errors_do_not_require_google_auth():
    """Cheap config errors must not depend on google-auth being importable.

    Mark only the google-auth import targets as missing. Do not unload
    ``google.protobuf`` / ``google.cloud`` — popping those native modules
    crashes Windows pytest workers.
    """
    blocked = {
        'google.auth': None,
        'google.oauth2': None,
        'google.oauth2.service_account': None,
    }
    with patch.dict(sys.modules, blocked, clear=False):
        with pytest.raises(GCPAuthError, match='Unknown authType'):
            get_gcp_credentials({'authType': 'bogus'})
        with pytest.raises(GCPAuthError, match='Service Account JSON key is required'):
            get_gcp_credentials({'authType': 'service_account'})
        with pytest.raises(GCPAuthError, match='Failed to parse Service Account JSON key'):
            get_gcp_credentials({'authType': 'service_account', 'serviceAccountKey': 'not-a-json'})
