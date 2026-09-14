# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Unit tests for text_output configuration validation (no live SMB server).

``validateConfig`` probes the target with ``connect()`` and has to separate two
kinds of failure:

* A configuration mistake the user must fix (rejected credential, share the
  account may not enter, share name that does not exist) has to fail validation.
* A server this host simply cannot reach must NOT fail validation. Validation
  also runs on the Platform host, which frequently has no route to the
  customer's share, and rejecting a correct configuration there is why the probe
  used to be commented out.

The classification uses NtStatus rather than errno, and these tests use the real
``smbprotocol`` exception classes rather than doubles, because the reason errno
does not work is a property of that package's real hierarchy: a rejected
credential is not an ``OSError`` at all, and ``STATUS_ACCESS_DENIED`` is absent
from the errno map so it arrives with ``errno == 0``. Doubles would let a broken
classifier pass.
"""

import errno
import sys
import types
from pathlib import Path

import pytest

NODES_SRC = Path(__file__).parent.parent.parent / 'src' / 'nodes'
# Move to the front rather than "insert only if absent": another test dir already on
# sys.path can hold a package with the same name as the node (see #1687).
while str(NODES_SRC) in sys.path:
    sys.path.remove(str(NODES_SRC))
sys.path.insert(0, str(NODES_SRC))

from text_output import endpoint as endpoint_module  # noqa: E402
from text_output.endpoint import Endpoint  # noqa: E402

smbprotocol_exceptions = pytest.importorskip('smbprotocol.exceptions')
smbprotocol_header = pytest.importorskip('smbprotocol.header')

SMBAuthenticationError = smbprotocol_exceptions.SMBAuthenticationError
SMBConnectionClosed = smbprotocol_exceptions.SMBConnectionClosed
SMBOSError = smbprotocol_exceptions.SMBOSError
NtStatus = smbprotocol_header.NtStatus


@pytest.fixture
def recorded(monkeypatch):
    """Capture engLib.error / engLib.warning instead of reporting to the engine."""
    calls = {'error': [], 'warning': []}
    monkeypatch.setattr(endpoint_module.engLib, 'error', lambda *a, **k: calls['error'].append(a))
    monkeypatch.setattr(endpoint_module.engLib, 'warning', lambda *a, **k: calls['warning'].append(a))
    return calls


def make_endpoint(connect_error=None, **overrides):
    """Build an Endpoint whose connect() raises the given error.

    The configuration accessors are properties over ``endpoint.parameters``, so a
    stub carrying that dict is enough; no engine object is needed.
    """
    parameters = {
        'server': 'files.example.com',
        'username': 'DOMAIN\\user',
        'password': 'secret',
        'storePath': 'share/folder',
        'anonymize': False,
    }
    parameters.update(overrides)

    instance = Endpoint.__new__(Endpoint)
    instance.endpoint = types.SimpleNamespace(parameters=parameters, jobConfig={'type': 'config'})

    def connect():
        if connect_error is not None:
            raise connect_error

    instance.connect = connect
    return instance


# -----------------------------------------------------------------------------
# The smbprotocol facts the classification depends on
# -----------------------------------------------------------------------------


def test_rejected_credential_is_not_an_oserror():
    """Why errno cannot be used: this class never carries one."""
    assert not issubclass(SMBAuthenticationError, OSError)
    assert issubclass(SMBAuthenticationError, smbprotocol_exceptions.SMBException)


def test_access_denied_is_not_mapped_onto_eacces():
    """Why errno cannot be used: the status is absent from smbprotocol's map."""
    denied = SMBOSError(NtStatus.STATUS_ACCESS_DENIED, '//server/share')

    assert denied.errno == 0
    assert denied.errno != errno.EACCES
    assert denied.ntstatus == NtStatus.STATUS_ACCESS_DENIED


def test_eperm_means_a_transient_sharing_violation():
    """Why EPERM must not reject: it is 'file in use', not a config mistake."""
    violation = SMBOSError(NtStatus.STATUS_SHARING_VIOLATION, '//server/share')

    assert violation.errno == errno.EPERM


# -----------------------------------------------------------------------------
# Failures that must reject the configuration
# -----------------------------------------------------------------------------


@pytest.mark.parametrize(
    ('label', 'error'),
    [
        ('rejected credential', SMBAuthenticationError('Failed to authenticate with server')),
        ('access denied', SMBOSError(NtStatus.STATUS_ACCESS_DENIED, '//server/share')),
        ('logon failure', SMBOSError(NtStatus.STATUS_LOGON_FAILURE, '//server/share')),
        ('wrong password', SMBOSError(NtStatus.STATUS_WRONG_PASSWORD, '//server/share')),
        ('expired password', SMBOSError(NtStatus.STATUS_PASSWORD_EXPIRED, '//server/share')),
        ('privilege not held', SMBOSError(NtStatus.STATUS_PRIVILEGE_NOT_HELD, '//server/share')),
        ('no such share', SMBOSError(NtStatus.STATUS_BAD_NETWORK_NAME, '//server/nope')),
        ('name not found', SMBOSError(NtStatus.STATUS_OBJECT_NAME_NOT_FOUND, '//server/share')),
        ('path not found', SMBOSError(NtStatus.STATUS_OBJECT_PATH_NOT_FOUND, '//server/share')),
    ],
)
def test_configuration_mistakes_fail_validation(recorded, label, error):
    make_endpoint(connect_error=error).validateConfig(syntaxOnly=False)

    assert recorded['error'], f'{label} must fail validation'
    assert not recorded['warning'], f'{label} must not be downgraded to a warning'


def test_classifier_reports_configuration_mistakes_directly():
    """The predicate is public, so exercise it without going through engLib."""
    assert Endpoint.is_smb_config_error(SMBAuthenticationError('nope')) is True
    assert Endpoint.is_smb_config_error(SMBOSError(NtStatus.STATUS_ACCESS_DENIED, '//s/x')) is True


# -----------------------------------------------------------------------------
# Failures that must NOT reject the configuration
# -----------------------------------------------------------------------------


@pytest.mark.parametrize(
    ('label', 'error'),
    [
        ('connection refused', ConnectionRefusedError(errno.ECONNREFUSED, 'Connection refused')),
        ('host unreachable', OSError(errno.EHOSTUNREACH, 'No route to host')),
        ('timed out', TimeoutError(errno.ETIMEDOUT, 'Connection timed out')),
        ('smb io timeout', SMBOSError(NtStatus.STATUS_IO_TIMEOUT, '//server/share')),
        ('transport closed', SMBConnectionClosed('The transport was closed')),
        ('sharing violation', SMBOSError(NtStatus.STATUS_SHARING_VIOLATION, '//server/share')),
        ('network name deleted', SMBOSError(NtStatus.STATUS_NETWORK_NAME_DELETED, '//server/share')),
        ('unrelated failure', RuntimeError('something unexpected')),
    ],
)
def test_unreachable_target_warns_without_rejecting(recorded, label, error):
    make_endpoint(connect_error=error).validateConfig(syntaxOnly=False)

    assert not recorded['error'], f'{label} must not reject the configuration'
    assert recorded['warning'], f'{label} should still be reported'


def test_warning_says_the_config_was_not_rejected(recorded):
    """The log line has to make clear validation did not fail."""
    make_endpoint(connect_error=ConnectionRefusedError(errno.ECONNREFUSED, 'refused')).validateConfig(syntaxOnly=False)

    assert 'config not rejected' in str(recorded['warning'][0][0])


# -----------------------------------------------------------------------------
# Probe scope and syntax validation
# -----------------------------------------------------------------------------


def test_syntax_only_never_probes(recorded):
    """A syntax-only pass must not touch the network, so a broken target is irrelevant."""
    probed = []

    instance = make_endpoint()
    instance.connect = lambda: probed.append(1) or (_ for _ in ()).throw(AssertionError('probed'))

    instance.validateConfig(syntaxOnly=True)

    assert probed == []
    assert not recorded['error']
    assert not recorded['warning']


def test_a_clean_probe_reports_nothing(recorded):
    make_endpoint().validateConfig(syntaxOnly=False)

    assert not recorded['error']
    assert not recorded['warning']


def test_invalid_server_name_still_fails_on_syntax(recorded):
    """Parameter validation keeps failing through the ValueError branch."""
    make_endpoint(server='not a valid host!').validateConfig(syntaxOnly=True)

    assert recorded['error']
