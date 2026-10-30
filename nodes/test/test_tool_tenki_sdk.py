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

"""Contract tests: the parts of the real tenki SDK that tool_tenki relies on, run against the pinned release.

test_tool_tenki.py fakes the SDK, so it cannot notice a release that changes what the node depends on. Run this
module against any new version before moving the pin in requirements.txt; it is skipped when tenki is not installed.
"""

from __future__ import annotations

import importlib.util
import inspect
import threading
import time
import tracemalloc
from pathlib import Path
from types import SimpleNamespace

import pytest

tenki = pytest.importorskip('tenki')

from tenki_sandbox import errors as sdk_errors
from tenki_sandbox._pb import pb
from tenki_sandbox._transport import _STREAMING_OUT, GrpcConfig, GrpcSandboxRPC
from tenki_sandbox.client import build_create_session_request
from tenki_sandbox import data_plane as data_plane_module
from tenki_sandbox.data_plane import GrpcDataPlaneRPC
from tenki_sandbox.errors import map_rpc_error
from tenki_sandbox.fs import SandboxFS
from tenki_sandbox.git import SandboxGit
from tenki_sandbox.process import Process, ProcessStream

_REQUIRED = inspect.Parameter.empty
_SHIMS = Path(__file__).resolve().parents[1] / 'src' / 'nodes' / 'tool_tenki' / 'sdk_shims.py'
_spec = importlib.util.spec_from_file_location('tool_tenki_sdk_shims', _SHIMS)
shims = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(shims)  # engine-free, so it runs against the real SDK here


def _parameters(function):
    """Each parameter's default (_REQUIRED when it has none), self left out."""
    return {name: p.default for name, p in inspect.signature(function).parameters.items() if name != 'self'}


def _session(plane, verified=True):
    """A real Sandbox whose data plane is ``plane``."""
    session = tenki.Sandbox(SimpleNamespace(_rpc=object()), tenki.SandboxInfo(id='sb-contract'))
    session._data_plane_rpc, session._data_plane_verified = plane, verified
    return session


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
        'QuotaExceededError',
    ],
)
def test_the_errors_the_node_handles_are_sandbox_errors(name):
    assert issubclass(getattr(tenki, name), tenki.SandboxError)  # otherwise a tool would crash instead of answering


def test_the_sdk_errors_that_are_also_plain_runtime_or_timeout_errors_are_exactly_the_known_ones():
    # The node wraps a plain RuntimeError or TimeoutError and lets an SDK error through as itself, so a new SDK error
    # that is also a plain one must be looked at before the pin moves.
    errors = [
        value
        for value in vars(sdk_errors).values()
        if isinstance(value, type) and issubclass(value, Exception) and value.__module__ == sdk_errors.__name__
    ]
    plain = {error for error in errors if issubclass(error, (RuntimeError, TimeoutError))}
    assert len(errors) > 10 and {error.__name__ for error in plain} == {
        'SnapshotFailedError',
        'SnapshotWaitTimeoutError',
    }
    assert not any(issubclass(error, (tenki.CommandTimeoutError, tenki.FileNotFoundError)) for error in plain)
    assert issubclass(tenki.FileNotFoundError, FileNotFoundError)


@pytest.mark.parametrize('name', ['WaitReadyFailedError', 'TemplateRuntimeFailedError'])
def test_a_failed_create_still_carries_what_it_left_running(name):
    carried = object()
    assert getattr(tenki, name)('not ready', carried).sandbox is carried
    assert not hasattr(tenki.SandboxInfo(id='x'), 'close')  # why a template failure is closed by id


@pytest.mark.parametrize(
    ('code', 'details', 'expected'),
    [
        ('FAILED_PRECONDITION', 'a condition the SDK does not recognise', 'InvalidStateError'),
        ('NOT_FOUND', 'a resource the SDK does not recognise', 'SessionNotFoundError'),
        ('NOT_FOUND', 'open /home/tenki/a.txt: no such file or directory', 'FileNotFoundError'),
        ('DEADLINE_EXCEEDED', 'deadline exceeded', 'CommandTimeoutError'),
        ('PERMISSION_DENIED', 'permission denied', 'PermissionDeniedError'),
        ('RESOURCE_EXHAUSTED', 'max concurrent jobs reached (limit: 5)', 'QuotaExceededError'),  # measured 2026-10-11
        ('UNAVAILABLE', 'Received http2 header with status: 502', 'SandboxError'),
        ('UNKNOWN', 'paused source is still being torn down, retry shortly', 'SandboxError'),
    ],
)
def test_the_error_mapping_the_node_is_designed_around(code, details, expected):
    # The two catch-alls are why recovery reads the session's state instead of trusting the error, and a failure the
    # SDK has no class for arrives as exactly SandboxError.
    class _RpcError(Exception):
        def code(self):
            return SimpleNamespace(name=code)

        def details(self):
            return details

    assert type(map_rpc_error(_RpcError())) is getattr(tenki, expected)


# ---------------------------------------------------------------------------
# Client and create
# ---------------------------------------------------------------------------


def test_the_client_takes_an_explicit_key_endpoint_and_deadline_and_refuses_a_key_without_tk():
    client = tenki.Client(
        auth_token='tk_mock-placeholder', base_url='https://api.tenki.cloud', timeout=60, rpc=object()
    )
    assert client.base_url == 'https://api.tenki.cloud' and callable(client.get) and callable(client.close)
    with pytest.raises(tenki.InvalidAuthTokenError):
        tenki.Client(auth_token='mock-placeholder', rpc=object())
    # The client's deadline applies to unary control-plane calls only; git has no data-plane call.
    assert (
        not {'create_session', 'get_session', 'resume_session', 'terminate_session', 'git_operation'} & _STREAMING_OUT
    )
    assert 'git_operation' not in GrpcDataPlaneRPC._methods


def test_create_accepts_every_option_the_node_sends_and_none_it_must_not():
    parameters = _parameters(tenki.Client.create)
    sent = {'cpu_cores', 'memory_mb', 'disk_size_gb', 'max_duration', 'pause_retention', 'allow_inbound'}
    sent |= {'allow_outbound', 'image', 'name', 'tags', 'metadata', 'secret_policies', 'allow_domains'}
    assert sent <= set(parameters)
    assert parameters['sticky'] is False  # a sticky session would discard max_duration
    assert parameters['allow_inbound'] is True and parameters['allow_outbound'] is True  # so the node sets both
    for name in ('secret_files', 'secret_overrides', 'setup_secrets'):  # these would put a value inside the VM
        assert parameters[name] is None, name


def test_sizing_left_unset_is_not_sent_so_an_image_keeps_its_own():
    # Dylan's review of 67a0b2f6, against this release: the node sends cpu, memory and disk only when set.
    assert "inherits\nthat source's disk unless this is set" in inspect.getdoc(tenki.Client.create)
    request = build_create_session_request(image='acme/node-env')
    assert (request.cpu_cores, request.memory_mb, request.disk_size_gb) == (0, 0, 0)
    assert build_create_session_request(image='acme/node-env', disk_size_gb=20).disk_size_gb == 20


def test_secret_policies_domains_and_outbound_access_reach_the_create_request():
    request = build_create_session_request(secret_policies=['github'], allow_domains=['pypi.org'], allow_outbound=True)
    assert list(request.secret_policies) == ['github'] and list(request.egress.allow_domains) == ['pypi.org']
    assert request.allow_outbound is True and not build_create_session_request().HasField('egress')


@pytest.mark.parametrize('options', [{'disk_size_gb': 4}, {'memory_mb': 4097}])
def test_the_resource_rules_the_node_clamps_to(options):
    with pytest.raises(tenki.InvalidResourceConfigError):
        build_create_session_request(**options)


def test_the_session_and_client_methods_the_node_calls():
    for name in ('start', 'refresh', 'resume', 'wait_ready', 'close', 'close_if_open'):
        assert callable(getattr(tenki.Sandbox, name)), name
    assert 'timeout' in _parameters(tenki.Sandbox.start) and 'timeout' in _parameters(tenki.Sandbox.wait_ready)
    assert 'tags' in _parameters(tenki.Client.list)
    names = {pb.SessionState.Name(value).removeprefix('SESSION_STATE_') for value in pb.SessionState.values()}
    assert {'RUNNING', 'PAUSED', 'RESUMING', 'TERMINATING', 'TERMINATED', 'USER_SHUTDOWN'} <= names


def test_sandbox_start_raises_a_plain_runtime_error_when_the_data_plane_is_unreachable():
    # Why the node reads the session's state after a plain RuntimeError too (point D of Dylan's review).
    session = _session(None)
    session._ensure_data_plane = lambda **kwargs: None
    with pytest.raises(RuntimeError) as raised:
        session.start('true')
    assert not isinstance(raised.value, tenki.SandboxError)


def test_records_and_results_have_the_fields_the_node_reads():
    # test_tool_tenki.py mirrors these two dataclasses.
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
        'disk',
    ]
    fields = ['path', 'size', 'mode', 'is_dir', 'modified_unix_ns', 'is_symlink', 'symlink_target']
    assert list(tenki.FileInfo.__dataclass_fields__) == fields
    result = tenki.CommandResult(argv=['bash'], exit_code=0, stdout='é'.encode(), timed_out=True)
    assert (result.stdout_text, result.stderr_text, result.timed_out) == ('é', '', True)


def test_the_file_and_git_api_signatures():
    assert _parameters(SandboxFS.write_text) == {'path': _REQUIRED, 'text': _REQUIRED, 'encoding': 'utf-8'}
    assert _parameters(SandboxFS.stat) == _parameters(SandboxFS.read_bytes) == {'path': _REQUIRED}
    assert _parameters(SandboxFS.list) == {'path': _REQUIRED, 'include_hidden': False}
    assert _parameters(SandboxFS.mkdir) == {'path': _REQUIRED, 'recursive': True, 'mode': 0o755}
    assert _parameters(SandboxFS.remove) == {'path': _REQUIRED, 'recursive': True}
    assert _parameters(SandboxGit.clone) == {'repo': _REQUIRED, 'branch': None, 'depth': None, 'directory': None}
    assert _parameters(SandboxGit.checkout) == {'ref': _REQUIRED, 'create': False, 'directory': None}
    assert _parameters(SandboxGit.diff) == {'range': None, 'base': None, 'head': None, 'path': None, 'directory': None}
    assert _parameters(SandboxGit.log) == {'max_count': None, 'range': None, 'path': None, 'directory': None}


def test_stat_reports_size_and_kind_and_read_bytes_is_one_unary_request():
    # read_file checks the size first because ReadFile takes no length and returns the whole file.
    calls = []

    class _Rpc:
        def stat(self, request):
            calls.append('stat')
            return pb.StatResponse(exists=request.path.endswith('a.txt'), size=5)

        def read_file(self, request):
            calls.append('read_file')
            return pb.ReadFileResponse(path=request.path, content=b'hello')

    fs = SandboxFS(_Rpc(), 'sb-contract')
    assert (fs.stat('/home/tenki/a.txt').size, fs.read_bytes('/home/tenki/a.txt')) == (5, b'hello')
    with pytest.raises(tenki.FileNotFoundError):
        fs.stat('/home/tenki/missing.txt')
    assert calls == ['stat', 'read_file', 'stat']
    assert [field.name for field in pb.ReadFileRequest.DESCRIPTOR.fields] == ['session_id', 'path']


# ---------------------------------------------------------------------------
# The file-call deadline (sdk_shims.bound_file_calls)
# ---------------------------------------------------------------------------


class _RecordingStub:
    """In place of a gRPC stub: notes the deadline each call arrived with, and has no network."""

    def __init__(self):
        self.deadlines = {}

    def __getattr__(self, name):
        def method(request, *args, **kwargs):
            self.deadlines[name] = kwargs.get('timeout', 'none sent')
            raise ConnectionError('no network in contract tests')

        return method


_FILE_RPCS = {'Stat', 'ReadFile', 'WriteFile', 'List', 'Mkdir', 'Remove'}


def _planes():
    """A real Sandbox over the SDK's own control and data planes, both on recording stubs."""
    config = GrpcConfig(base_url='https://127.0.0.1:9', auth_token='tk_mock-placeholder', timeout=60)
    control = GrpcSandboxRPC(config)
    control_stub = _RecordingStub()
    object.__setattr__(control, '_stub', control_stub)
    session = tenki.Sandbox(SimpleNamespace(_rpc=control), tenki.SandboxInfo(id='sb-contract'))
    data = GrpcDataPlaneRPC('https://127.0.0.1:9', SimpleNamespace(current=lambda: ''))
    data_stub = data._stub = _RecordingStub()
    session._data_plane_rpc, session._data_plane_verified = data, True
    return session, control_stub, data_stub


def _every_file_call(session):
    files = session.fs
    for call in (
        lambda: files.stat('/home/tenki/a'),
        lambda: files.read_bytes('/home/tenki/a'),
        lambda: files.write_text('/home/tenki/a', 'x'),
        lambda: files.list('/home/tenki', include_hidden=False),
        lambda: files.mkdir('/home/tenki/d'),
        lambda: files.remove('/home/tenki/d'),
    ):
        with pytest.raises(tenki.SandboxError):
            call()


def test_the_sdk_sends_file_calls_with_no_deadline_and_the_node_adds_one_to_every_one():
    session, control_stub, data_stub = _planes()
    _every_file_call(session)
    assert data_stub.deadlines == dict.fromkeys(_FILE_RPCS, 'none sent')  # why the node adds one
    session, control_stub, data_stub = _planes()
    shims.bound_file_calls(session, 75)
    _every_file_call(session)
    assert data_stub.deadlines == dict.fromkeys(_FILE_RPCS, 75) and control_stub.deadlines == {}
    assert {GrpcDataPlaneRPC._methods[name] for name in shims.UNARY_FILE_CALLS} == _FILE_RPCS


def test_the_deadline_holds_on_the_control_plane_fallback_and_after_a_resume_resets_the_data_plane():
    session, control_stub, _ = _planes()
    shims.bound_file_calls(session, 75)
    session._data_plane_rpc, session._ensure_data_plane = None, lambda **kwargs: None
    _every_file_call(session)
    assert control_stub.deadlines == dict.fromkeys(_FILE_RPCS, 75)
    session, _, _ = _planes()
    shims.bound_file_calls(session, 75)
    session._reset_data_plane()
    fresh = GrpcDataPlaneRPC('https://127.0.0.1:9', SimpleNamespace(current=lambda: ''))
    fresh_stub = fresh._stub = _RecordingStub()
    session._data_plane_rpc, session._data_plane_verified = fresh, True
    _every_file_call(session)
    assert fresh_stub.deadlines == dict.fromkeys(_FILE_RPCS, 75)


# ---------------------------------------------------------------------------
# Processes: the start, the warm-up, and the output swap
# ---------------------------------------------------------------------------


class _DataPlane:
    """In place of a session's data plane: runs commands as ``frames`` says, answers Stat, counts the SDK's check."""

    endpoint = 'https://127.0.0.1:9'

    def __init__(self, frames=None):
        self.checks, self.frames = 0, frames

    def ensure_serving(self, session_id, **kwargs):
        self.checks += 1

    def run(self, requests, **kwargs):
        next(iter(requests))  # the start
        if self.frames is not None:
            yield from self.frames()
            return
        yield pb.RunResponse(started=pb.RunStarted(pid=7))
        yield pb.RunResponse(exit=pb.RunExit(exit_code=0))

    def stat(self, request, **kwargs):
        return pb.StatResponse(exists=True)

    def close(self):
        pass


def test_close_stdin_waits_for_the_start_and_re_raises_a_run_error_that_followed_it():
    # Dylan's review of 67a0b2f6: the node counts a command as started when the SDK has its pid, even when
    # close_stdin raises, because the run error can arrive after the started frame.
    def started_then_cut():
        yield pb.RunResponse(started=pb.RunStarted(pid=7))
        raise ConnectionError('the VM paused')

    process = _session(_DataPlane(started_then_cut)).start('git', 'push', timeout=10)
    assert process._done.wait(timeout=5)
    with pytest.raises(tenki.SandboxError):
        process.close_stdin()
    assert process.pid == 7
    assert _parameters(Process.close_stdin) == {} and _parameters(Process.kill) == {}
    assert 'timeout' in _parameters(Process.wait) and isinstance(inspect.getattr_static(Process, 'pid'), property)


def test_a_failed_run_ends_both_output_streams_with_its_error_and_sets_done_first():
    class _NoNetwork:
        def run(self, requests):
            raise ConnectionError('no network in contract tests')

    process = Process(_NoNetwork(), 'sb-contract', ['true'])
    for stream in (process.stdout, process.stderr):
        with pytest.raises(tenki.SandboxError):
            list(stream)
    with pytest.raises(tenki.SandboxError):
        process.wait(timeout=5)
    # The output guard skips the kill once _done is set, which the SDK does before it ends the streams.
    source = inspect.getsource(Process._pump)
    assert process._done.is_set() and source.index('self._done.set()') < source.index('self.stdout.close()')
    stream = ProcessStream()
    stream.push(b'a')
    stream.close()
    assert list(stream) == [b'a'] and stream.read() == b'a'  # the SDK keeps its own copy of everything read


def test_a_commands_first_answer_spares_file_calls_the_sdks_unbounded_check_and_a_resume_brings_it_back():
    # Why the node runs a no-op command after every create and resume (IGlobal._warm_up).
    plane = _DataPlane()
    session = _session(plane, verified=False)
    session.fs.stat('/home/tenki')
    assert plane.checks == 1 and 'timeout' not in inspect.getsource(data_plane_module.GrpcDataPlaneRPC.ensure_serving)
    plane = _DataPlane()
    session = _session(plane, verified=False)
    process = session.start('true', timeout=10)
    process.close_stdin()
    assert process.wait(timeout=10).exit_code == 0
    session.fs.stat('/home/tenki')
    assert plane.checks == 0
    assert 'self._reset_data_plane()' in inspect.getsource(tenki.Sandbox.resume)
    session._reset_data_plane()
    assert session._data_plane_verified is False


class _FloodingDataPlane(_DataPlane):
    """A command that prints ``before`` bytes, waits for ``go_on``, prints ``after`` more in 64 KiB frames, exits 0."""

    frame = b'y\n' * 32768

    def __init__(self, before: int, after: int):
        super().__init__(self._flood)
        self.before, self.after, self.go_on = before, after, threading.Event()

    def _flood(self):
        yield pb.RunResponse(started=pb.RunStarted(pid=7))
        for _ in range(self.before // len(self.frame)):
            yield pb.RunResponse(stdout=self.frame)
        self.go_on.wait(timeout=30)
        for _ in range(self.after // len(self.frame)):
            yield pb.RunResponse(stdout=self.frame)
        yield pb.RunResponse(exit=pb.RunExit(exit_code=0))


def test_once_the_node_swaps_a_processs_streams_the_sdk_keeps_none_of_the_output_that_follows():
    # Holds only while the SDK's stream thread looks the streams up for every frame: were it to keep the ones it
    # started with, or keep frames anywhere else, the 64 MiB after the swap would stay in memory.
    before, after = 1024 * 1024, 64 * 1024 * 1024
    plane = _FloodingDataPlane(before, after)
    process = _session(plane).start('yes', timeout=60)
    process.close_stdin()
    first = process.stdout
    deadline = time.monotonic() + 30
    while len(first.read()) < before:
        assert time.monotonic() < deadline, 'the frames before the swap never arrived'
        time.sleep(0.01)
    reader = threading.Thread(target=lambda: sum(1 for _ in first), daemon=True)
    reader.start()
    tracing = tracemalloc.is_tracing()
    if not tracing:
        tracemalloc.start()
    try:
        tracemalloc.reset_peak()
        baseline = tracemalloc.get_traced_memory()[0]
        shims.stop_keeping_output(process)
        plane.go_on.set()
        result = process.wait(timeout=60)
        grown, peak = (size - baseline for size in tracemalloc.get_traced_memory())
    finally:
        if not tracing:
            tracemalloc.stop()
    assert result.exit_code == 0 and result.stdout == b'' and len(first.read()) == before
    assert peak < 4 * 1024 * 1024 and grown < 1024 * 1024, f'peak {peak:,} bytes, still held {grown:,} bytes'
    reader.join(timeout=5)
    assert not reader.is_alive()  # ending the stream the SDK started with releases a reader blocked on it
