# =============================================================================
# RocketRide Engine
# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================

"""Contract tests: the parts of the real tenki SDK that tool_tenki depends on.

test_tool_tenki.py replaces the SDK with stubs and fakes, so it cannot notice an SDK release that
renames or reshapes something the node uses. This module imports the real package and checks exactly
those things; it is skipped when tenki is not installed. requirements.txt pins the version these were
written against, so run this module against any new version before bumping the pin.
"""

from __future__ import annotations

import inspect
from types import SimpleNamespace

import pytest

tenki = pytest.importorskip('tenki')

from tenki_sandbox._pb import pb
from tenki_sandbox._transport import _STREAMING_OUT
from tenki_sandbox.client import build_create_session_request
from tenki_sandbox.errors import map_rpc_error
from tenki_sandbox.fs import SandboxFS
from tenki_sandbox.git import SandboxGit
from tenki_sandbox.process import Process

_REQUIRED = inspect.Parameter.empty


def _parameters(function):
    """Map each parameter name to its default (_REQUIRED when it has none), leaving out self."""
    return {
        name: parameter.default for name, parameter in inspect.signature(function).parameters.items() if name != 'self'
    }


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    'name',
    [
        'SessionNotFoundError',
        'SessionTerminatedError',
        'InvalidStateError',
        'WaitReadyFailedError',
        'TemplateRuntimeFailedError',
        'CommandTimeoutError',
        'PermissionDeniedError',
        'FileNotFoundError',
    ],
)
def test_the_errors_the_node_handles_are_sandbox_errors(name):
    # The tools catch SandboxError; an error that stopped subclassing it would escape as a crash.
    assert issubclass(getattr(tenki, name), tenki.SandboxError)


def test_the_sdk_file_not_found_error_still_subclasses_the_builtin():
    assert issubclass(tenki.FileNotFoundError, FileNotFoundError)


@pytest.mark.parametrize('name', ['WaitReadyFailedError', 'TemplateRuntimeFailedError'])
def test_a_failed_create_still_carries_what_it_left_running(name):
    # IGlobal reads error.sandbox to close a billing VM; after a rename it would silently close nothing.
    carried = object()
    assert getattr(tenki, name)('not ready', carried).sandbox is carried


@pytest.mark.parametrize(
    ('code', 'details', 'expected'),
    [
        ('FAILED_PRECONDITION', 'a condition the SDK does not recognise', 'InvalidStateError'),
        ('NOT_FOUND', 'a resource the SDK does not recognise', 'SessionNotFoundError'),
        ('NOT_FOUND', 'open /home/tenki/a.txt: no such file or directory', 'FileNotFoundError'),
        ('DEADLINE_EXCEEDED', 'deadline exceeded', 'CommandTimeoutError'),
        ('PERMISSION_DENIED', 'permission denied', 'PermissionDeniedError'),
    ],
)
def test_the_error_mapping_the_node_is_designed_around(code, details, expected):
    # The two catch-alls are why recovery checks a session's real state instead of trusting the error;
    # the file-not-found mapping is what lets write_file create a missing parent directory.
    class _RpcError(Exception):
        def code(self):
            return SimpleNamespace(name=code)

        def details(self):
            return details

    assert type(map_rpc_error(_RpcError())) is getattr(tenki, expected)


# ---------------------------------------------------------------------------
# Client and session creation
# ---------------------------------------------------------------------------


def test_the_client_takes_an_explicit_key_endpoint_and_deadline():
    offline = object()
    client = tenki.Client(
        auth_token='tk_mock-tenki-placeholder-for-tests', base_url='https://api.tenki.cloud', timeout=60, rpc=offline
    )
    assert client.base_url == 'https://api.tenki.cloud'
    assert callable(client.get) and callable(client.close)


def test_the_client_refuses_a_key_without_the_tk_prefix_before_any_request():
    with pytest.raises(tenki.InvalidAuthTokenError):
        tenki.Client(auth_token='mock-tenki-placeholder-for-tests', rpc=object())


def test_the_client_deadline_covers_every_unary_call_the_node_makes():
    # The deadline IGlobal passes, and the clone limit git_clone describes, apply only to unary calls.
    unary = {'create_session', 'get_session', 'resume_session', 'terminate_session', 'git_operation'}
    assert not unary & _STREAMING_OUT


def test_create_accepts_every_option_the_node_sends():
    parameters = _parameters(tenki.Client.create)
    for name in (
        'cpu_cores',
        'memory_mb',
        'disk_size_gb',
        'idle_timeout_minutes',
        'max_duration',
        'allow_inbound',
        'image',
        'name',
        'tags',
        'metadata',
    ):
        assert name in parameters, name
    assert parameters['sticky'] is False  # relied on: a sticky session would discard max_duration
    assert parameters['allow_inbound'] is True  # so the node has to pass False itself


@pytest.mark.parametrize('options', [{'disk_size_gb': 4}, {'memory_mb': 4097}])
def test_the_resource_rules_the_node_clamps_to(options):
    # IGlobal clamps disk_size_gb to at least 5 and rounds memory_mb down to even because of these.
    with pytest.raises(tenki.InvalidResourceConfigError):
        build_create_session_request(**options)


# ---------------------------------------------------------------------------
# Sessions, processes and results
# ---------------------------------------------------------------------------


def test_sessions_can_be_listed_by_tag_and_closed_for_shutdown_cleanup():
    # endGlobal lists this run's sessions by tag and closes each; a rename here would let a
    # leaked, billing VM survive teardown while the stubbed unit tests stayed green.
    assert 'tags' in _parameters(tenki.Client.list)
    assert callable(tenki.Sandbox.close_if_open)


def test_the_session_methods_the_node_calls():
    for name in ('start', 'refresh', 'resume', 'wait_ready', 'close', 'close_if_open'):
        assert callable(getattr(tenki.Sandbox, name)), name
    assert {'cwd', 'env', 'timeout', 'stdin', 'privileged'} <= set(_parameters(tenki.Sandbox.start))
    assert 'timeout' in _parameters(tenki.Sandbox.wait_ready)
    assert isinstance(inspect.getattr_static(tenki.Sandbox, 'id'), property)


def test_a_process_can_be_waited_on_with_a_limit_and_cancelled():
    assert _parameters(Process.close_stdin) == {}
    assert 'timeout' in _parameters(Process.wait)
    assert _parameters(Process.kill) == {}


def test_the_session_states_the_node_compares_against_still_exist():
    # IGlobal compares SandboxInfo.state with these names; a renamed state would break recovery quietly.
    names = {pb.SessionState.Name(value).removeprefix('SESSION_STATE_') for value in pb.SessionState.values()}
    assert {'RUNNING', 'PAUSED', 'TERMINATING', 'TERMINATED', 'USER_SHUTDOWN'} <= names


def test_records_and_results_have_the_fields_the_node_reads():
    assert {'id', 'state'} <= set(tenki.SandboxInfo.__dataclass_fields__)
    assert not hasattr(tenki.SandboxInfo(id='x'), 'close')  # why a template failure is closed by id
    # test_tool_tenki.py mirrors these two dataclasses; keep the mirrors in step with them.
    assert list(tenki.CommandResult.__dataclass_fields__) == [
        'argv',
        'exit_code',
        'stdout',
        'stderr',
        'signal',
        'duration_ms',
        'reason',
        'errno',
        'timed_out',
    ]
    assert list(tenki.FileInfo.__dataclass_fields__) == [
        'path',
        'size',
        'mode',
        'is_dir',
        'modified_unix_ns',
        'is_symlink',
        'symlink_target',
    ]
    result = tenki.CommandResult(argv=['bash'], exit_code=0, stdout='é'.encode(), timed_out=True)
    assert (result.stdout_text, result.stderr_text, result.timed_out) == ('é', '', True)


# ---------------------------------------------------------------------------
# File and git APIs
# ---------------------------------------------------------------------------


def test_the_file_api_signatures():
    assert _parameters(SandboxFS.write_text) == {'path': _REQUIRED, 'text': _REQUIRED, 'encoding': 'utf-8'}
    assert inspect.isgeneratorfunction(SandboxFS.read_stream)  # so read_file can close it
    assert _parameters(SandboxFS.read_stream) == {'path': _REQUIRED, 'offset': 0, 'length': 0, 'chunk_bytes': 0}
    assert _parameters(SandboxFS.list) == {'path': _REQUIRED, 'include_hidden': False}
    assert _parameters(SandboxFS.mkdir) == {'path': _REQUIRED, 'recursive': True, 'mode': 0o755}
    assert _parameters(SandboxFS.remove) == {'path': _REQUIRED, 'recursive': True}


def test_the_git_api_signatures():
    assert _parameters(SandboxGit.clone) == {'repo': _REQUIRED, 'branch': None, 'depth': None, 'directory': None}
    assert _parameters(SandboxGit.checkout) == {'ref': _REQUIRED, 'create': False, 'directory': None}
    assert _parameters(SandboxGit.diff) == {'range': None, 'base': None, 'head': None, 'path': None, 'directory': None}
    assert _parameters(SandboxGit.log) == {'max_count': None, 'range': None, 'path': None, 'directory': None}
