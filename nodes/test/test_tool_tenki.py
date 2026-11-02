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

"""Unit tests for tool_tenki: what an operator or an agent sees (no network, no real keys)."""

from __future__ import annotations

import dataclasses
import importlib
import importlib.util
import itertools
import json
import os
import posixpath
import queue
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

# Bootstrap: under a bare interpreter, stub the engine modules that are not already loaded, import the node, then
# remove the stubs again (see test_tool_tavily.py for the full rationale).
_ROOT = Path(__file__).resolve().parents[2]
_NODES_SRC = _ROOT / 'nodes' / 'src'
_UTILS = _ROOT / 'packages' / 'ai' / 'src' / 'ai' / 'common' / 'utils'
if str(_NODES_SRC) not in sys.path:
    sys.path.insert(0, str(_NODES_SRC))
_KEY = 'tk_mock-tenki-placeholder-for-tests'  # the real SDK refuses a key without tk_ before any request


class _SandboxError(Exception):
    pass


class _CarriesSandbox(_SandboxError):
    def __init__(self, message, sandbox=None):
        super().__init__(message)
        self.sandbox = sandbox


def _tool_function(*, input_schema=None, description=None, output_schema=None):
    def decorator(fn):
        fn.__tool_meta__ = {'input_schema': input_schema, 'description': description, 'output_schema': output_schema}
        return fn

    return decorator


class _InstanceBase:
    def _collect_tool_methods(self):
        cls = type(self)
        return {name: getattr(self, name) for name in dir(cls) if hasattr(getattr(cls, name), '__tool_meta__')}


def _stubs() -> dict:
    rocketlib = MagicMock(IInstanceBase=_InstanceBase, IGlobalBase=object, tool_function=_tool_function)
    rocketlib.debug = rocketlib.warning = rocketlib.error = lambda *a, **kw: None
    tenki = MagicMock(SandboxError=_SandboxError, WaitReadyFailedError=_CarriesSandbox)
    tenki.TemplateRuntimeFailedError = type('TemplateRuntimeFailedError', (_CarriesSandbox,), {})
    tenki.FileNotFoundError = type('FileNotFoundError', (_SandboxError, FileNotFoundError), {})
    for name in ('SessionNotFoundError', 'SessionTerminatedError', 'InvalidStateError', 'CommandTimeoutError'):
        setattr(tenki, name, type(name, (_SandboxError,), {}))
    for name in ('PermissionDeniedError', 'QuotaExceededError'):
        setattr(tenki, name, type(name, (_SandboxError,), {}))
    names = ('depends', 'ai', 'ai.common', 'ai.common.config')
    return {'rocketlib': rocketlib, 'tenki': tenki, **{name: MagicMock() for name in names}}


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


_added = []
for _name, _stub in _stubs().items():
    if _name not in sys.modules:
        sys.modules[_name] = _stub
        _added.append(_name)
if 'ai.common.utils' not in sys.modules:
    # The real argument helpers, loaded from source as tool_gohighlevel's tests do, plus config_int.
    sys.modules['ai.common.utils'] = _load('ai.common.utils', _UTILS / 'tool_args.py')
    sys.modules['ai.common.utils'].config_int = _load('_tenki_config_utils', _UTILS / 'config_utils.py').config_int
    _added.append('ai.common.utils')
mod = importlib.import_module('nodes.tool_tenki.IGlobal')
inst_mod = importlib.import_module('nodes.tool_tenki.IInstance')
shims = importlib.import_module('nodes.tool_tenki.sdk_shims')
for _name in _added:
    sys.modules.pop(_name, None)

_SERVICES = json.loads((_NODES_SRC / 'nodes' / 'tool_tenki' / 'services.json').read_text())


def _raise(error):
    raise error


# ---------------------------------------------------------------------------
# Fakes for the Tenki SDK (the network)
# ---------------------------------------------------------------------------


@dataclasses.dataclass(frozen=True)
class _Result:
    """Mirror of tenki.CommandResult (its fields are pinned in test_tool_tenki_sdk.py)."""

    argv: list
    exit_code: int = 0
    stdout: bytes = b''
    stderr: bytes = b''
    signal: str | None = None
    duration_ms: int | None = None
    reason: str | None = None
    errno: int | None = None
    timed_out: bool = False
    disk: object | None = None

    stdout_text = property(lambda self: self.stdout.decode(errors='replace'))
    stderr_text = property(lambda self: self.stderr.decode(errors='replace'))


@dataclasses.dataclass(frozen=True)
class _Info:
    """Mirror of tenki.FileInfo; in a listing, ``path`` is the entry's name."""

    path: str
    size: int = 0
    mode: int = 0o644
    is_dir: bool = False
    modified_unix_ns: int = 0
    is_symlink: bool = False
    symlink_target: str = ''


class _Stream:
    """tenki's ProcessStream: chunks pushed by the run, read by iterating until it is closed or failed."""

    def __init__(self):
        self._queue, self._chunks = queue.Queue(), []

    def push(self, data):
        if data:
            self._chunks.append(data)
            self._queue.put(data)

    def read(self):
        return b''.join(self._chunks)

    def close(self):
        self._queue.put(None)

    def fail(self, error):
        self._queue.put(error)

    def __iter__(self):
        while (item := self._queue.get()) is not None:
            if isinstance(item, Exception):
                raise item
            yield item


_PIDS = itertools.count(4000)


class _Process:
    """tenki's Process. ``start`` is 'ok', 'stalls' (close_stdin times out), or the error close_stdin raises.

    As in the SDK, each chunk goes to whatever ``stdout`` is when it arrives, so a swapped stream keeps nothing.
    ``flood`` (chunk, budget) prints until the node's kill reaches the marker; with ``escapes`` it prints on.
    """

    def __init__(self, session, argv, marker=None, *, result=None, start='ok', pid=True, run_error=None, **run):
        self.session, self.argv, self.marker = session, argv, marker
        self.pid = next(_PIDS) if pid else None
        self.stdout, self.stderr = _Stream(), _Stream()
        self.killed, self._done = threading.Event(), threading.Event()
        self._start, self._run_error, self._result = start, run_error, result or _Result(argv=list(argv))
        self._stalls, self._flood, self.escapes = run.get('stalls'), run.get('flood'), run.get('escapes')
        if not self._stalls:
            threading.Thread(target=self._run, daemon=True).start()

    def _run(self):
        if self._run_error is not None:
            self.stdout.fail(self._run_error)
            self.stderr.fail(self._run_error)
        elif self._flood:
            chunk, budget = self._flood
            for _ in range(budget // len(chunk)):
                if self.killed.is_set() and not self.escapes:
                    break
                self.stdout.push(chunk)
                time.sleep(0.002)
            self._result = dataclasses.replace(self._result, stdout=self.stdout.read())
        else:
            self.stdout.push(self._result.stdout)
            self.stderr.push(self._result.stderr)
        self._done.set()
        self.stdout.close()
        self.stderr.close()

    def close_stdin(self):
        self.session.calls.append('close_stdin')
        if self._start == 'stalls':
            raise TimeoutError('timed out waiting for command start')
        if isinstance(self._start, Exception):
            raise self._start

    def wait(self, timeout=None):
        if self._stalls or not self._done.wait(timeout):
            self.kill()
            raise TimeoutError('timed out waiting for command')
        if self._run_error is not None:
            raise self._run_error
        return self._result

    def kill(self):
        self.session.calls.append(('kill', self.argv[0]))


class _Rpc:
    """The object SandboxFS sends every call through; records the deadline each call was sent with."""

    def __init__(self, session):
        self._session = session

    def __getattr__(self, name):
        def call(operation, timeout=None):
            self._session.deadlines.append((name, timeout))
            self._session.enter(name)
            return operation()

        return call


class _FS:
    """tenki's SandboxFS over an in-memory tree, with the SDK's signatures (and no streaming read)."""

    def __init__(self, session):
        self.s, self._rpc = session, _Rpc(session)

    @staticmethod
    def _missing(path):
        return mod.TenkiFileNotFoundError(f'stat {path}: no such file or directory')

    def write_text(self, path, text, encoding='utf-8'):
        def write():
            if posixpath.dirname(path) not in self.s.dirs:
                raise self._missing(path)
            self.s.files[path] = text

        return self._rpc.write_file(write)

    def stat(self, path):
        def stat():
            if path in self.s.dirs:
                return _Info(path, 4096, is_dir=True)
            if path not in self.s.files:
                raise self._missing(path)
            return _Info(path, len(self.s.files[path].encode()))

        return self._rpc.stat(stat)

    def read_bytes(self, path):
        return self._rpc.read_file(lambda: self.s.reads.append(path) or self.s.files[path].encode())

    def list(self, path, include_hidden=False):
        def entries():
            if path not in self.s.dirs:
                raise self._missing(path)
            found = [_Info(posixpath.basename(d), is_dir=True) for d in self.s.dirs if posixpath.dirname(d) == path]
            found += [
                _Info(posixpath.basename(f), len(t)) for f, t in self.s.files.items() if posixpath.dirname(f) == path
            ]
            return [entry for entry in found if include_hidden or not entry.path.startswith('.')]

        return self._rpc.list(entries)

    def mkdir(self, path, recursive=True, mode=0o755):
        def mkdir():
            p = path
            while p not in self.s.dirs:
                self.s.dirs.add(p)
                p = posixpath.dirname(p)

        return self._rpc.mkdir(mkdir)

    def remove(self, path, recursive=True):
        def remove():
            if path not in self.s.files and path not in self.s.dirs:
                raise self._missing(path)
            self.s.files = {f: t for f, t in self.s.files.items() if f != path and not f.startswith(path + '/')}
            self.s.dirs = {d for d in self.s.dirs if d != path and not d.startswith(path + '/')}

        return self._rpc.remove(remove)


class _Git:
    """tenki's SandboxGit, with the SDK's signatures; each call returns git's raw output."""

    def __init__(self, session):
        self.s = session

    def _call(self, operation, **kwargs):
        self.s.calls.append((operation, kwargs))
        self.s.enter(operation)
        return self.s.git_outputs.get(operation, '')

    def clone(self, repo, branch=None, depth=None, directory=None):
        return self._call('clone', repo=repo, branch=branch, depth=depth, directory=directory)

    def checkout(self, ref, create=False, directory=None):
        return self._call('checkout', ref=ref, create=create, directory=directory)

    def diff(self, range=None, base=None, head=None, path=None, directory=None):
        return self._call('diff', range=range, base=base, head=head, path=path, directory=directory)

    def log(self, max_count=None, range=None, path=None, directory=None):
        return self._call('log', max_count=max_count, range=range, path=path, directory=directory)


class _Session:
    """tenki.Sandbox. While PAUSED or ended, file and git calls fail and a command never starts, as measured.

    ``script(argv)`` may return keyword arguments for a tool command's _Process (and change the state).
    """

    def __init__(self, sid='sb-1', *, state='RUNNING', files=None, dirs=(), git=None, fail=None, script=None):
        self.id, self.state = sid, state
        self.files, self.dirs = dict(files or {}), {'/home/tenki', *dirs}
        self.git_outputs, self.fail, self.script = dict(git or {}), dict(fail or {}), script
        self.calls, self.deadlines, self.reads, self.runs = [], [], [], []
        self.paused_error = mod.InvalidStateError('session is paused')
        self.paused_start_error = None  # raised by start itself, as Sandbox.start raises a plain RuntimeError
        self.resume_refusals, self.ready_error, self.ready_gate, self.barrier = 0, None, None, None
        self.kill_tree_error = self.kill_tree_report = self.client = None
        self.fs, self.git = _FS(self), _Git(self)

    def _down(self):
        if self.state == 'PAUSED':
            return self.paused_error
        if self.state == 'GONE':
            return mod.SessionNotFoundError('session not found')
        if self.state in ('TERMINATED', 'USER_SHUTDOWN'):
            return mod.SessionTerminatedError('session_terminated')
        return None

    def enter(self, operation):
        down = self._down()
        if down is not None:
            if self.barrier is not None:
                self.barrier.wait(timeout=5)
            raise down
        if operation in self.fail:
            raise self.fail[operation]

    def start(self, *argv, cwd=None, env=None, timeout=None, stdin=None, privileged=False):
        marker = None
        if argv[0] == 'env' and argv[1].startswith('TOOL_TENKI_RUN='):
            marker, argv = argv[1], argv[2:]
        self.calls.append(('start', argv, timeout))
        down = self._down()
        if down is not None:
            if self.paused_start_error is not None:
                raise self.paused_start_error
            return _Process(self, argv, start=down, pid=False, run_error=down)
        if argv[3:4] == ('tool_tenki-kill',):
            return self._kill_tree(argv[4])
        if argv == ('true',):
            return _Process(self, argv)
        process = _Process(self, argv, marker, **((self.script and self.script(argv)) or {}))
        self.runs.append(process)
        return process

    def _kill_tree(self, marker):
        self.calls.append('kill_tree')
        if self.kill_tree_error is not None:
            raise self.kill_tree_error
        hits = [p for p in self.runs if p.marker == marker and not p.escapes and not p._done.is_set()]
        for process in hits:
            process.killed.set()
        report = self.kill_tree_report or f'found={len(hits)} killed={len(hits)} left=0'
        return _Process(self, ('kill',), result=_Result(argv=['kill'], stdout=report.encode()))

    def refresh(self):
        self.calls.append('refresh')
        if self.state == 'GONE':
            raise mod.SessionNotFoundError('session not found')
        return SimpleNamespace(id=self.id, state=self.state)

    def resume(self):
        self.calls.append('resume')
        if self.resume_refusals:
            self.resume_refusals -= 1
            raise mod.SandboxError('paused source is still being torn down, retry shortly')
        self.state = 'RUNNING'

    def wait_ready(self, timeout=None):
        self.calls.append(('wait_ready', timeout))
        if self.ready_gate is not None:
            self.ready_gate.wait(timeout=5)
        if self.ready_error is not None:
            raise self.ready_error

    def close(self):
        self.calls.append('close')
        if self.client is not None and self.client.closed:
            raise mod.SandboxError('Cannot invoke RPC on closed channel!')
        self.state = 'TERMINATED'

    def close_if_open(self):
        if self.state not in ('TERMINATING', 'TERMINATED'):
            self.close()

    def commands(self):
        """The argv of every tool command started, the node's no-op commands and kills left out."""
        return [process.argv for process in self.runs]


class _Client:
    def __init__(self, *sessions, create_error=None, leftover=(), list_error=None, create_gate=None):
        self.sessions, self.created, self.list_calls, self.fetched = list(sessions), [], [], {}
        self.create_error, self.leftover, self.list_error, self.create_gate = (
            create_error,
            leftover,
            list_error,
            create_gate,
        )
        self.closed = False

    def create(self, **kwargs):
        self.created.append(kwargs)
        if self.create_gate is not None:
            self.create_gate.wait(timeout=5)
        if self.closed:  # closing the channel cancels a create in flight
            raise mod.SandboxError('Cannot invoke RPC on closed channel!')
        if self.create_error is not None:
            raise self.create_error
        session = self.sessions.pop(0)
        session.client = self
        return session

    def get(self, sid):
        self.fetched[sid] = _Session(sid)
        return self.fetched[sid]

    def list(self, tags=None):
        self.list_calls.append(tags)
        if self.list_error is not None:
            raise self.list_error
        return list(self.leftover)

    def close(self):
        self.closed = True


@pytest.fixture
def logs(monkeypatch):
    captured = []
    for module in (mod, inst_mod):
        monkeypatch.setattr(module, 'warning', lambda message, *a, **kw: captured.append(str(message)))
    monkeypatch.setattr(mod, 'debug', lambda *a, **kw: None)
    monkeypatch.setattr(mod, '_RESUME_RETRY_PAUSE_SECS', 0.01)
    return captured


def _global(monkeypatch, cfg, client=None):
    """An IGlobal over ``cfg`` (beginGlobal not yet run), and the kwargs of every Client it builds."""
    built = []
    monkeypatch.setattr(mod, 'Client', lambda **kwargs: built.append(kwargs) or client or _Client())
    monkeypatch.setattr(mod, 'Config', SimpleNamespace(getNodeConfig=lambda *a: dict(cfg)))
    glb = mod.IGlobal()
    glb.IEndpoint = SimpleNamespace(endpoint=SimpleNamespace(openMode=object()))
    glb.glb = SimpleNamespace(logicalType='tool_tenki', connConfig={})
    return glb, built


def _started(monkeypatch, cfg=None):
    glb, built = _global(monkeypatch, {'apikey': _KEY, **(cfg or {})})
    glb.beginGlobal()
    return glb, built


def _instance(monkeypatch, *sessions, cfg=None, **client_kwargs):
    client = _Client(*sessions, **client_kwargs)
    glb, _ = _global(monkeypatch, {'apikey': _KEY, **(cfg or {})}, client)
    glb.beginGlobal()
    inst = inst_mod.IInstance()
    inst.IGlobal = glb
    return inst, client


def _used(monkeypatch, session, *more, cfg=None, **client_kwargs):
    """An instance whose session was created and used once, so it is warm."""
    inst, client = _instance(monkeypatch, session, *more, cfg=cfg, **client_kwargs)
    inst.list_files({})
    return inst, client


def _parallel(*calls):
    results = [None] * len(calls)
    threads = [threading.Thread(target=lambda i=i, c=c: results.__setitem__(i, c())) for i, c in enumerate(calls)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=20)
    return results


def _wait_for(condition):
    deadline = time.monotonic() + 5
    while not condition():
        assert time.monotonic() < deadline, 'timed out'
        time.sleep(0.01)


def _pause_on_first_run(session, **process):
    """A session Tenki pauses while (or just after starting) its first tool command, as measured on real VMs."""

    def script(argv):
        if session.runs:
            return {}
        session.state = 'PAUSED'
        return process

    session.script = script
    return session


_CUT = 'session_terminated:terminate_requested: termination requested'


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------


def test_a_missing_key_stops_startup_before_a_client_exists(monkeypatch, logs):
    glb, built = _global(monkeypatch, {'apikey': '  '})
    with pytest.raises(Exception, match='apikey is required'):
        glb.beginGlobal()
    assert built == []


def test_the_client_gets_the_stripped_key_the_public_endpoint_and_a_deadline(monkeypatch, logs):
    _, built = _started(monkeypatch, {'apikey': f'  {_KEY} ', 'exec_timeout_secs': 300})
    assert built == [{'auth_token': _KEY, 'base_url': 'https://api.tenki.cloud', 'timeout': 300}]
    _, built = _started(monkeypatch, {'base_url': 'https://tenki.example', 'exec_timeout_secs': 5})
    assert built == [{'auth_token': _KEY, 'base_url': 'https://tenki.example', 'timeout': 60}]


def test_the_editor_opens_the_node_without_a_key(monkeypatch, logs):
    glb, built = _global(monkeypatch, {})
    glb.IEndpoint.endpoint.openMode = mod.OPEN_MODE.CONFIG
    glb.beginGlobal()
    assert built == []


@pytest.mark.parametrize(
    ('field', 'configured', 'expected'),
    [
        ('max_duration_minutes', 100000, 1440),
        ('pause_retention_hours', 100000, 8760),
        ('exec_timeout_secs', 99999, 1200),
        ('exec_timeout_secs', 0, 120),  # config_int: 0 means "not set", not "1 second"
        ('exec_timeout_secs', 'soon', 120),
        ('max_output_chars', 10, 1000),
        ('max_output_chars', 10**9, 1000000),
        ('cpu_cores', 64, 16),
        ('memory_mb', 128, 512),
        ('memory_mb', 4097, 4096),  # Tenki rejects odd sizes
        ('disk_size_gb', 1, 5),  # the SDK refuses less than 5 before sending
        ('disk_size_gb', -3, 0),
    ],
)
def test_integer_settings_are_clamped_or_fall_back_to_their_default(monkeypatch, logs, field, configured, expected):
    assert getattr(_started(monkeypatch, {field: configured})[0], field) == expected


@pytest.mark.parametrize(('exec_timeout', 'minutes', 'warns'), [(120, 60, False), (60, 1, True), (59, 1, False)])
def test_a_command_allowed_to_outlive_the_session_is_warned_about(monkeypatch, logs, exec_timeout, minutes, warns):
    cfg = {'exec_timeout_secs': exec_timeout, 'max_duration_minutes': minutes}
    _started(monkeypatch, cfg)
    assert any('can never finish' in line for line in logs) is warns
    logs.clear()
    _global(monkeypatch, {'apikey': _KEY, **cfg})[0].validateConfig()
    assert any('can never finish' in line for line in logs) is warns


@pytest.mark.parametrize(
    ('cfg', 'warning'),
    [
        ({}, 'apikey is required'),
        ({'apikey': 'mock-key'}, 'starts with tk_'),
        ({'toolGroups': ['nope']}, 'will fail to start: tenki.toolGroups matched no known'),
        ({'toolGroups': ['git', 'nope']}, 'unknown tool group(s): nope'),
        ({'label': 'My_Agent'}, 'will fail to start: tenki.label must be'),
        ({'allow_domains': ['https://pypi.org']}, 'will fail to start: tenki.allow_domains'),
        ({'git_auth_secret': 'GH'}, 'will fail to start: tenki.git_auth_secret is set but'),
    ],
)
def test_the_editor_warns_about_a_setting_that_will_stop_the_pipeline(monkeypatch, logs, cfg, warning):
    _global(monkeypatch, {'apikey': _KEY, **cfg} if cfg else {})[0].validateConfig()
    assert any(warning in line for line in logs), logs


def test_the_editor_reports_a_config_it_cannot_read(monkeypatch, logs):
    glb, _ = _global(monkeypatch, {})
    monkeypatch.setattr(mod, 'Config', SimpleNamespace(getNodeConfig=lambda *a: _raise(KeyError('connConfig'))))
    glb.validateConfig()
    assert any('connConfig' in line for line in logs)


@pytest.mark.parametrize(
    ('configured', 'published'),
    [
        (None, {'execution', 'filesystem', 'git'}),
        ([], {'execution', 'filesystem', 'git'}),
        (['all'], {'execution', 'filesystem', 'git'}),
        (['Git', 'filesystem'], {'git', 'filesystem'}),
        ('execution, git', {'execution', 'git'}),
        (['git', 'typo'], {'git'}),
    ],
)
def test_tool_groups_choose_what_is_published(monkeypatch, logs, configured, published):
    assert _started(monkeypatch, {'toolGroups': configured})[0].tool_groups == published
    assert any('ignoring unknown tool group(s): typo' in line for line in logs) is ('typo' in str(configured))


@pytest.mark.parametrize('configured', [['typo'], {'git': True}])
def test_tool_groups_that_match_nothing_stop_startup_instead_of_publishing_everything(monkeypatch, logs, configured):
    glb, built = _global(monkeypatch, {'apikey': _KEY, 'toolGroups': configured})
    with pytest.raises(ValueError, match='toolGroups'):
        glb.beginGlobal()
    assert built == []


_GROUP_TOOLS = {
    'execution': {'run_command', 'run_code'},
    'filesystem': {'write_file', 'edit_file', 'read_file', 'list_files', 'make_directory', 'delete_path'},
    'git': {'git_clone', 'git_checkout', 'git_diff', 'git_log'},
}


@pytest.mark.parametrize('group', sorted(_GROUP_TOOLS))
def test_each_group_publishes_exactly_its_own_tools(monkeypatch, logs, group):
    inst, _ = _instance(monkeypatch, cfg={'toolGroups': [group]})
    assert set(inst._collect_tool_methods()) == _GROUP_TOOLS[group]


def test_every_tool_is_in_a_group_the_editor_offers(monkeypatch, logs):
    inst, _ = _instance(monkeypatch)
    assert set(inst._collect_tool_methods()) == set().union(*_GROUP_TOOLS.values())
    offered = {value for value, _ in _SERVICES['fields']['tenki.toolGroups']['items']['enum']}
    assert offered == mod.TOOL_GROUPS | {'all'}


def test_the_label_names_the_session_and_rides_in_its_metadata(monkeypatch, logs):
    _, client = _used(monkeypatch, _Session(), cfg={'label': 'agent-2'})
    [create] = client.created
    assert create['name'].startswith('rocketride-tool-tenki-agent-2-')
    assert create['metadata'] == {'created_by': 'rocketride', 'node': 'tool_tenki', 'label': 'agent-2'}


@pytest.mark.parametrize('label', ['My_Agent', 'Agent', '-a', 'a' * 33, 'team*a'])
def test_a_label_outside_lowercase_letters_digits_and_hyphens_stops_startup(monkeypatch, logs, label):
    # Dylan's review of 67a0b2f6: the rule is what was measured to work in a session name, and it comes before the
    # value, because the engine cuts a startup error at its first asterisk.
    glb, _ = _global(monkeypatch, {'apikey': _KEY, 'label': label})
    with pytest.raises(ValueError) as refused:
        glb.beginGlobal()
    assert str(refused.value).startswith('tenki.label must be 1 to 32 lowercase letters, digits or "-", starting')


def test_allowed_domains_are_sent_as_tenki_normalizes_them(monkeypatch, logs):
    _, client = _used(monkeypatch, _Session(), cfg={'allow_domains': 'PyPI.org., *.github.com, pypi.org'})
    assert client.created[0]['allow_domains'] == ['pypi.org', '*.github.com']


@pytest.mark.parametrize(
    'entry', ['https://pypi.org', 'pypi.org:443', 'under_score.org', '*.*.org', '10.0.0.0/8', 'ｐypi.org']
)
def test_an_allowlist_entry_tenki_refuses_stops_startup_naming_the_rule_first(monkeypatch, logs, entry):
    glb, _ = _global(monkeypatch, {'apikey': _KEY, 'allow_domains': ['ok.org', entry]})
    with pytest.raises(ValueError) as refused:
        glb.beginGlobal()
    assert str(refused.value).startswith('tenki.allow_domains has an entry Tenki refuses (entry 2). Use bare hostnames')


def test_an_allowlist_entry_that_may_carry_a_credential_is_not_repeated(monkeypatch, logs):
    glb, _ = _global(monkeypatch, {'apikey': _KEY, 'allow_domains': ['https://user:hunter2@host.org']})
    with pytest.raises(ValueError) as refused:
        glb.beginGlobal()
    assert 'hunter2' not in str(refused.value) and 'may hold a credential' in str(refused.value)


@pytest.mark.parametrize(
    'value', [{'pypi.org': True}, ['pypi.org', None], [f'h{i}.org' for i in range(257)]], ids=['dict', 'none', '257']
)
def test_an_allowlist_in_the_wrong_shape_or_too_long_stops_startup(monkeypatch, logs, value):
    glb, _ = _global(monkeypatch, {'apikey': _KEY, 'allow_domains': value})
    with pytest.raises(ValueError, match='allow_domains'):
        glb.beginGlobal()


def test_secret_policies_need_an_allowlist_and_only_their_names_are_sent(monkeypatch, logs):
    glb, _ = _global(monkeypatch, {'apikey': _KEY, 'secret_policies': ['github']})
    with pytest.raises(ValueError, match='allow_domains is empty'):
        glb.beginGlobal()
    cfg = {'secret_policies': ['github'], 'allow_domains': ['github.com'], 'secret_files': ['x'], 'tailnet': 'x'}
    _, client = _used(monkeypatch, _Session(), cfg=cfg)
    assert client.created[0]['secret_policies'] == ['github'] and 'secret_files' not in client.created[0]


@pytest.mark.parametrize('image', ['', 'acme/node-env'])
def test_the_create_request_carries_exactly_the_options_the_node_means_to_send(monkeypatch, logs, image):
    # Dylan's review of 67a0b2f6: with an image Tenki keeps the image's disk unless disk_size_gb is sent, so unset
    # sizing is not sent at all. Without an image Tenki's defaults (2 vCPU, 4096 MB, 5 GB) apply, as before.
    inst, client = _used(monkeypatch, _Session(), cfg={'image': image, 'max_duration_minutes': 90})
    [create] = client.created
    expected = {'max_duration', 'pause_retention', 'allow_inbound', 'allow_outbound', 'name', 'tags', 'metadata'}
    assert set(create) == expected | ({'image'} if image else set())
    assert (create['max_duration'], create['pause_retention']) == (5400, 24 * 3600)
    assert create['allow_inbound'] is False and create['allow_outbound'] is True
    assert create['tags'] == ['rocketride', inst.IGlobal._run_tag] and create.get('image', '') == image


def test_sizing_is_sent_when_set(monkeypatch, logs):
    cfg = {'cpu_cores': 4, 'memory_mb': 8193, 'disk_size_gb': 20, 'image': 'acme/node-env'}
    _, client = _used(monkeypatch, _Session(), cfg=cfg)
    sizing = {key: client.created[0][key] for key in ('cpu_cores', 'memory_mb', 'disk_size_gb')}
    assert sizing == {'cpu_cores': 4, 'memory_mb': 8192, 'disk_size_gb': 20}


def test_two_runs_tag_their_sessions_differently(monkeypatch, logs):
    assert _started(monkeypatch)[0]._run_tag != _started(monkeypatch)[0]._run_tag


# ---------------------------------------------------------------------------
# Private repositories (git_auth_url and git_auth_secret)
# ---------------------------------------------------------------------------

_PRIVATE = {'secret_policies': ['github'], 'allow_domains': ['github.com'], 'git_auth_secret': 'GITHUB_BASIC'}


@pytest.mark.parametrize(
    ('url', 'prefix'),
    [
        (None, 'https://github.com/'),
        ('HTTPS://GitHub.com/acme', 'https://github.com/acme/'),
        ('https://github.com', 'https://github.com/'),
    ],
)
def test_the_private_prefix_is_kept_in_the_form_git_matches(monkeypatch, logs, url, prefix):
    glb, _ = _started(monkeypatch, {**_PRIVATE, 'git_auth_url': url})
    assert (glb.git_auth_url, glb.git_auth_secret) == (prefix, 'GITHUB_BASIC')


@pytest.mark.parametrize(
    ('cfg', 'refusal'),
    [
        ({'git_auth_url': 'https://u:p@github.com/'}, 'not shown'),
        ({'git_auth_url': 'https://github.com:8443/'}, 'must be an https URL'),
        ({'git_auth_url': 'http://github.com/'}, 'must be an https URL'),
        ({'git_auth_url': 'https://github.com/a/../b'}, 'must be an https URL'),
        ({'git_auth_url': 7}, 'must be a URL'),
        ({'git_auth_secret': '9lives'}, 'must be the name of a Tenki secret'),
        ({'git_auth_secret': 'ghp_' + 'a' * 36}, 'looks like a credential value'),
        ({'git_auth_secret': 'sk-ant-api03-abcdefgh12345678'}, 'looks like a credential value'),
        ({'secret_policies': []}, 'secret_policies is empty'),
        ({'allow_domains': ['gitlab.com']}, 'which tenki.allow_domains does not list'),
        ({'allow_domains': ['*.github.com']}, 'which tenki.allow_domains does not list'),  # one label only
    ],
)
def test_a_private_clone_setting_that_cannot_work_stops_startup(monkeypatch, logs, cfg, refusal):
    glb, _ = _global(monkeypatch, {'apikey': _KEY, **_PRIVATE, **cfg})
    with pytest.raises(ValueError, match=refusal) as refused:
        glb.beginGlobal()
    assert 'ghp_' not in str(refused.value) and 'abcdefgh' not in str(refused.value)


@pytest.mark.parametrize('name', ['tk_github_basic', 'sk-shared-github', 'AKIA_LEGACY_POLICY'])
def test_a_secret_name_that_merely_begins_like_a_token_is_accepted(monkeypatch, logs, name):
    assert _started(monkeypatch, {**_PRIVATE, 'git_auth_secret': name})[0].git_auth_secret == name


def test_the_clone_description_says_which_private_repositories_can_be_cloned(monkeypatch, logs):
    inst, _ = _instance(monkeypatch, cfg={'git_auth_url': 'https://github.com/acme/'})
    assert 'Private repositories cannot be cloned' in inst.git_clone.__tool_meta__['description'](inst)
    inst, _ = _instance(monkeypatch, cfg={**_PRIVATE, 'git_auth_url': 'https://github.com/acme/'})
    expected = 'Private repositories under https://github.com/acme/ can be cloned'
    assert expected in inst.git_clone.__tool_meta__['description'](inst)


# ---------------------------------------------------------------------------
# The session: creation, warm-up, recovery, shutdown
# ---------------------------------------------------------------------------


def test_the_session_is_created_on_first_use_and_reused(monkeypatch, logs):
    inst, client = _instance(monkeypatch, _Session())
    assert client.created == []  # beginGlobal never provisions: sessions bill
    assert inst.list_files({})['session'] == 'created'
    assert 'session' not in inst.list_files({}) and len(client.created) == 1


def test_parallel_first_calls_create_one_session(monkeypatch, logs):
    inst, client = _instance(monkeypatch, _Session(), _Session('sb-2'))
    results = _parallel(*[lambda: inst.list_files({})] * 6)
    assert len(client.created) == 1 and [r.get('session') for r in results].count('created') == 1


def test_a_new_session_runs_one_bounded_no_op_command_before_its_first_call(monkeypatch, logs):
    session = _Session()
    inst, _ = _used(monkeypatch, session)
    inst.list_files({})
    assert [call for call in session.calls if call[0] == 'start'] == [('start', ('true',), 10)]


def test_a_no_op_command_that_never_starts_is_reported_and_tried_again(monkeypatch, logs):
    session, stalls = _Session(), [True]
    start = session.start
    session.start = lambda *argv, **kw: (
        _Process(session, argv, start='stalls') if argv == ('true',) and stalls and stalls.pop() else start(*argv, **kw)
    )
    inst, _ = _instance(monkeypatch, session)
    assert "did not start the node's first command in time" in inst.list_files({})['error']
    assert inst.list_files({})['entries'] == []


def test_a_paused_session_is_resumed_never_replaced_warmed_up_again_and_the_call_retried(monkeypatch, logs):
    session = _Session(files={'/home/tenki/notes.txt': 'kept'})
    inst, client = _used(monkeypatch, session)
    session.state = 'PAUSED'
    assert inst.read_file({'path': 'notes.txt'}) == {
        'path': '/home/tenki/notes.txt',
        'content': 'kept',
        'truncated': False,
        'session': 'resumed',
    }
    assert session.calls.count('resume') == 1 and len(client.created) == 1
    assert [call for call in session.calls if call[0] == 'start'][-1] == ('start', ('true',), 10)


def test_a_parallel_wave_on_a_paused_session_resumes_it_once_and_every_call_says_so(monkeypatch, logs):
    session = _Session(files={'/home/tenki/a': '1'})
    inst, _ = _used(monkeypatch, session)
    session.state, session.barrier = 'PAUSED', threading.Barrier(4)
    results = _parallel(*[lambda: inst.read_file({'path': 'a'})] * 4)
    assert [(r['content'], r['session']) for r in results] == [('1', 'resumed')] * 4
    assert session.calls.count('resume') == 1


@pytest.mark.parametrize(
    'paused_error',
    [
        mod.SandboxError('dial guest-agent stream: failed to connect to vsock'),
        mod.TenkiFileNotFoundError('failed to read vsock CONNECT response: connect: no such file or directory'),
        mod.SessionNotFoundError('session not found'),
    ],
    ids=['unclassified', 'vsock-missing-file', 'not-found'],
)
def test_a_pause_reported_in_any_measured_form_is_resumed(monkeypatch, logs, paused_error):
    session = _Session(files={'/home/tenki/a': '1'})
    inst, _ = _used(monkeypatch, session)
    session.state, session.paused_error = 'PAUSED', paused_error
    assert inst.read_file({'path': 'a'})['session'] == 'resumed'


@pytest.mark.parametrize('state', ['TERMINATED', 'USER_SHUTDOWN', 'GONE'])
def test_an_ended_session_is_replaced_for_a_call_that_can_start_fresh(monkeypatch, logs, state):
    dead, fresh = _Session(), _Session('sb-2')
    inst, client = _used(monkeypatch, dead, fresh)
    dead.state = state
    result = inst.write_file({'path': 'a.txt', 'content': 'x'})
    assert (result['success'], result['session']) == (True, 'replaced')
    assert fresh.files == {'/home/tenki/a.txt': 'x'} and len(client.created) == 2
    assert ('close' in dead.calls) is (state != 'TERMINATED')  # closed even when reported not found: it may bill
    assert any('the next call starts a new, empty session' in line for line in logs)


@pytest.mark.parametrize(
    ('tool', 'args'),
    [
        ('read_file', {'path': 'a'}),
        ('list_files', {}),
        ('edit_file', {'path': 'a', 'old_text': 'x', 'new_text': 'y'}),
        ('delete_path', {'path': 'a'}),
        ('git_checkout', {'ref': 'main'}),
        ('git_diff', {}),
        ('git_log', {}),
    ],
)
def test_a_call_a_fresh_session_cannot_serve_says_the_session_ended_and_creates_nothing(monkeypatch, logs, tool, args):
    dead = _Session()
    inst, client = _used(monkeypatch, dead)
    dead.state = 'TERMINATED'
    result = getattr(inst, tool)(args)
    assert result['session'] == 'ended' and 'its files are gone' in result['error'] and len(client.created) == 1


def test_a_failure_the_state_does_not_explain_is_reported_as_it_is(monkeypatch, logs):
    session = _Session(fail={'list': mod.InvalidStateError('directory not empty')})
    inst, _ = _instance(monkeypatch, session)
    assert inst.list_files({})['error'] == 'directory not empty'
    assert session.calls.count('refresh') == 1 and 'resume' not in session.calls


def test_an_error_the_sdk_did_classify_costs_no_look_at_the_session(monkeypatch, logs):
    session = _Session()
    inst, _ = _instance(monkeypatch, session)
    assert inst.read_file({'path': 'vsock.txt'})['error'] == 'no such file or directory: /home/tenki/vsock.txt'
    assert 'refresh' not in session.calls
    assert inst.write_file({'path': 'vsock/a', 'content': 'x'})['success'] and '/home/tenki/vsock' in session.dirs


def test_a_plain_runtime_error_from_a_paused_sessions_start_goes_through_recovery(monkeypatch, logs):
    # Dylan's review of 67a0b2f6: Sandbox.start raises "sandbox data-plane endpoint unavailable" as a plain
    # RuntimeError, which used to be wrapped without a look at the session.
    session = _Session()
    inst, _ = _used(monkeypatch, session)
    session.state, session.paused_start_error = 'PAUSED', RuntimeError('sandbox data-plane endpoint unavailable')
    result = inst.run_command({'command': 'ls'})
    assert (result['exit_code'], result['session']) == (0, 'resumed')


def test_a_plain_runtime_error_on_a_running_session_is_an_error_result(monkeypatch, logs):
    inst, _ = _instance(monkeypatch, _Session(fail={'list': RuntimeError('sandbox run stream closed before exit')}))
    assert inst.list_files({})['error'] == 'sandbox run stream closed before exit'
    assert any('failed with RuntimeError' in line for line in logs)


def test_a_refused_resume_is_asked_again_while_the_session_still_waits(monkeypatch, logs):
    session = _Session(files={'/home/tenki/a': '1'})
    inst, _ = _used(monkeypatch, session)
    session.state, session.resume_refusals = 'PAUSED', 2
    assert inst.read_file({'path': 'a'})['session'] == 'resumed' and session.calls.count('resume') == 3


def test_a_resume_refused_for_the_whole_budget_is_reported_and_the_session_kept(monkeypatch, logs):
    monkeypatch.setattr(mod, '_RESUME_RETRY_SECS', 0.1)
    session = _Session()
    inst, client = _used(monkeypatch, session)
    session.state, session.resume_refusals = 'PAUSED', 10**6
    assert 'still being torn down' in inst.list_files({})['error']
    assert inst.IGlobal.session is session and len(client.created) == 1
    assert any('still being torn down' in line and 'not asked again' in line for line in logs)


def test_calls_queued_behind_a_resume_refused_for_the_whole_budget_ask_once_each(monkeypatch, logs):
    # Found in review of the rework: each queued call waited out a budget of its own, one after another under the
    # lock (four calls, eight minutes at the real 120 s).
    monkeypatch.setattr(mod, '_RESUME_RETRY_SECS', 0.3)
    session = _Session()
    inst, _ = _used(monkeypatch, session)
    session.state, session.resume_refusals, session.barrier = 'PAUSED', 10**6, threading.Barrier(4)
    started = time.monotonic()
    results = _parallel(*[lambda: inst.list_files({})] * 4)
    assert all('still being torn down' in result['error'] for result in results)
    assert time.monotonic() - started < 0.9 and session.calls.count('resume') <= 0.3 / 0.01 + 4


def test_calls_queued_behind_a_given_up_resume_that_tenki_carried_out_are_resumed(monkeypatch, logs):
    # Found in the second review: the last refused ask was carried out (the session went on to RESUMING), and the calls
    # queued behind it failed with the pause instead of waiting for the resume.
    monkeypatch.setattr(mod, '_RESUME_RETRY_SECS', 0.1)
    session = _Session()
    inst, _ = _used(monkeypatch, session)
    session.state, session.resume_refusals, session.barrier = 'PAUSED', 10**6, threading.Barrier(3)
    refresh = session.refresh

    def carried_out_after_all():
        if session.state == 'PAUSED' and any('not asked again' in line for line in logs):
            session.state = 'RESUMING'
        return refresh()

    session.refresh = carried_out_after_all
    results = _parallel(*[lambda: inst.list_files({})] * 3)
    assert sorted(result.get('session', 'error') for result in results) == ['error', 'resumed', 'resumed']


def test_a_pause_after_one_whose_resume_was_given_up_gets_a_budget_of_its_own(monkeypatch, logs):
    # Found in the second review: the give-up mark outlived a session that came back without the node's resume.
    monkeypatch.setattr(mod, '_RESUME_RETRY_SECS', 0.1)
    session = _Session()
    inst, _ = _used(monkeypatch, session)
    session.state, session.resume_refusals = 'PAUSED', 10**6
    assert 'still being torn down' in inst.list_files({})['error']
    session.state, session.resume_refusals = 'RUNNING', 0  # resumed from outside the node
    assert inst.list_files({})['entries'] == []
    session.state, session.resume_refusals = 'PAUSED', 2
    # The real budget: in 0.1 s a busy CI runner ran out of time for two refusals. A stale give-up mark still fails here,
    # since it leaves a budget of 0.
    monkeypatch.setattr(mod, '_RESUME_RETRY_SECS', 120)
    assert inst.list_files({})['session'] == 'resumed'


@pytest.mark.parametrize(('after', 'event'), [('RUNNING', 'resumed'), ('TERMINATED', 'replaced')])
def test_the_state_after_a_refused_resume_decides_what_happens(monkeypatch, logs, after, event):
    session = _Session(files={'/home/tenki/a': '1'})
    inst, _ = _used(monkeypatch, session, _Session('sb-2'))
    session.state = 'PAUSED'

    def refused():
        session.calls.append('resume')
        session.state = after
        raise mod.SandboxError('snapshot not yet durable on a reachable host')

    session.resume = refused
    assert inst.make_directory({'path': 'd'})['session'] == event and session.calls.count('resume') == 1


def test_a_resumed_session_that_does_not_come_up_is_reported_and_kept(monkeypatch, logs):
    session = _Session()
    inst, client = _used(monkeypatch, session)
    session.state, session.ready_error = 'PAUSED', TimeoutError('timeout waiting for sandbox')
    assert 'did not finish resuming' in inst.list_files({})['error'] and inst.IGlobal.session is session
    session.ready_error = None
    assert inst.list_files({})['entries'] == [] and len(client.created) == 1


@pytest.mark.parametrize(
    ('tool', 'args', 'event'),
    [('write_file', {'path': 'a', 'content': 'x'}, 'replaced'), ('read_file', {'path': 'a'}, 'ended')],
)
def test_a_session_that_ends_while_it_resumes_is_dropped(monkeypatch, logs, tool, args, event):
    session = _Session()
    inst, _ = _used(monkeypatch, session, _Session('sb-2'))
    session.state = 'PAUSED'
    session.wait_ready = lambda timeout=None: (
        setattr(session, 'state', 'TERMINATED'),
        _raise(RuntimeError('sandbox entered terminal state')),
    )
    assert getattr(inst, tool)(args)['session'] == event


@pytest.mark.parametrize(('tool', 'args'), [('read_file', {'path': 'a'}), ('run_command', {'command': 'ls'})])
def test_a_resumed_session_dropped_before_the_retry_is_not_swapped_for_a_fresh_one(monkeypatch, logs, tool, args):
    # Found in review of the rework: the retry fetched the session again, so it could run on a fresh, empty one, or
    # create one for a read, and still say "resumed".
    session = _Session(files={'/home/tenki/a': '1'})
    inst, client = _used(monkeypatch, session, _Session('sb-2'))
    session.state = 'PAUSED'
    glb = inst.IGlobal
    recover = glb._recover

    def another_call_drops_it_right_after(*args):
        event = recover(*args)
        session.state, glb.session = 'TERMINATED', None  # between this call's recovery and its retry
        return event

    glb._recover = another_call_drops_it_right_after
    result = getattr(inst, tool)(args)
    assert 'error' in result and result['session'] == 'resumed' and len(client.created) == 1


def test_a_look_at_the_session_that_runs_past_its_deadline_is_not_the_calls_timeout(monkeypatch, logs):
    session = _Session()
    inst, _ = _used(monkeypatch, session)
    session.state = 'PAUSED'
    session.refresh = lambda: _raise(mod.CommandTimeoutError('Deadline Exceeded'))
    result = inst.run_command({'command': 'ls'})
    assert result['timed_out'] is False and 'recovering the sandbox ran past the deadline' in result['error']


def test_shutdown_closes_the_session_and_the_client_and_nothing_is_used_after(monkeypatch, logs):
    session = _Session()
    inst, client = _used(monkeypatch, session)
    inst.IGlobal.endGlobal()
    assert session.state == 'TERMINATED' and client.closed and inst.IGlobal.session is None
    assert 'shutting down' in inst.list_files({})['error']


def test_shutdown_does_not_wait_out_a_resume(monkeypatch, logs):
    # Dylan's review of 67a0b2f6: teardown used to wait up to 180 s behind a resume while the VM billed.
    monkeypatch.setattr(mod, '_END_LOCK_WAIT_SECS', 0.2)
    session = _Session()
    inst, _ = _used(monkeypatch, session)
    session.state, session.ready_gate = 'PAUSED', threading.Event()
    results = []
    call = threading.Thread(target=lambda: results.append(inst.list_files({})))
    call.start()
    _wait_for(lambda: 'resume' in session.calls)
    started = time.monotonic()
    inst.IGlobal.endGlobal()
    assert time.monotonic() - started < 2 and 'close' in session.calls
    session.ready_gate.set()
    call.join(timeout=5)
    assert 'shutting down' in results[0]['error']


def test_a_create_that_finishes_after_shutdown_gave_up_on_it_closes_its_own_session(monkeypatch, logs):
    monkeypatch.setattr(mod, '_END_LOCK_WAIT_SECS', 0.2)
    session = _Session()
    inst, client = _instance(monkeypatch, session, create_gate=threading.Event())
    results = []
    call = threading.Thread(target=lambda: results.append(inst.list_files({})))
    call.start()
    _wait_for(lambda: client.created)
    inst.IGlobal.endGlobal()
    client.create_gate.set()
    call.join(timeout=5)
    assert session.state == 'TERMINATED' and 'shutting down' in results[0]['error']


def test_a_failed_create_that_finishes_after_shutdown_gave_up_on_it_still_closes_what_it_left(monkeypatch, logs):
    # Found in the second review: endGlobal dropped the client it had left open, so the failed create's VM billed on.
    monkeypatch.setattr(mod, '_END_LOCK_WAIT_SECS', 0.2)
    record = SimpleNamespace(id='sb-t', state='RUNNING')
    error = mod.TemplateRuntimeFailedError('runtime failed', record)
    inst, client = _instance(monkeypatch, create_error=error, create_gate=threading.Event())
    call = threading.Thread(target=lambda: inst.list_files({}))
    call.start()
    _wait_for(lambda: client.created)
    inst.IGlobal.endGlobal()
    client.create_gate.set()
    call.join(timeout=5)
    assert client.fetched['sb-t'].state == 'TERMINATED'


def test_shutdown_sweeps_this_runs_sessions_left_running_and_skips_ended_ones(monkeypatch, logs):
    # Dylan's review of 67a0b2f6: USER_SHUTDOWN sessions were closed again, with a false "left running" warning.
    left, gone = _Session('sb-left'), _Session('sb-gone', state='USER_SHUTDOWN')
    inst, client = _used(monkeypatch, _Session(), leftover=[left, gone])
    inst.IGlobal.endGlobal()
    assert client.list_calls == [[inst.IGlobal._run_tag]] and left.calls == ['close'] and gone.calls == []
    assert [line for line in logs if 'left running' in line] == [
        'tool_tenki: closed session sb-left, which shutdown had left running'
    ]


def test_shutdown_of_a_run_that_never_created_a_session_stays_off_the_network(monkeypatch, logs):
    inst, client = _instance(monkeypatch)
    inst.IGlobal.endGlobal()
    assert client.list_calls == [] and client.closed
    mod.IGlobal().endGlobal()  # endGlobal of a node that never started (config mode) is harmless


def test_shutdown_logs_what_failed_and_still_closes_the_client(monkeypatch, logs):
    session = _Session()
    inst, client = _used(monkeypatch, session, list_error=ConnectionError('offline'))
    session.close = lambda: _raise(mod.SandboxError('close refused'))
    inst.IGlobal.endGlobal()
    assert client.closed and any('could not close the session: close refused' in line for line in logs)
    assert any("could not list this run's sessions to clean up: offline" in line for line in logs)


def test_a_create_that_left_a_sandbox_running_closes_it(monkeypatch, logs):
    carried = _Session('sb-half')
    inst, _ = _instance(monkeypatch, create_error=mod.WaitReadyFailedError('not ready', carried))
    assert 'not ready' in inst.list_files({})['error'] and carried.state == 'TERMINATED'
    record = SimpleNamespace(id='sb-t', state='RUNNING')
    inst, client = _instance(monkeypatch, create_error=mod.TemplateRuntimeFailedError('runtime failed', record))
    inst.list_files({})
    assert client.fetched['sb-t'].state == 'TERMINATED'


@pytest.mark.parametrize(
    ('error', 'cfg', 'says', 'logged'),
    [
        (mod.PermissionDeniedError('API key requires Secrets access'), _PRIVATE, 'needs Secrets access', 'Secrets'),
        (mod.QuotaExceededError('max concurrent jobs reached (limit: 5)'), {}, 'limit of the Tenki', "workspace's"),
        (mod.PermissionDeniedError('API key requires Secrets access'), {}, 'API key requires Secrets access', None),
    ],
)
def test_a_refused_create_is_explained_to_the_agent_and_logged_once(monkeypatch, logs, error, cfg, says, logged):
    inst, _ = _instance(monkeypatch, create_error=error, cfg=cfg)
    assert says in inst.list_files({})['error']
    inst.list_files({})
    assert sum(1 for line in logs if logged and logged in line) == (1 if logged else 0)


def test_every_file_call_is_sent_with_the_deadline(monkeypatch, logs):
    session = _Session(files={'/home/tenki/a': 'x'})
    inst, _ = _instance(monkeypatch, session, cfg={'exec_timeout_secs': 90})
    inst.read_file({'path': 'a'})
    inst.write_file({'path': 'b', 'content': 'y'})
    inst.list_files({})
    inst.make_directory({'path': 'd'})
    inst.delete_path({'path': 'd'})
    assert {name for name, _ in session.deadlines} == shims.UNARY_FILE_CALLS
    assert {timeout for _, timeout in session.deadlines} == {90}


def test_a_session_whose_file_calls_cannot_be_bounded_is_closed_instead_of_used(monkeypatch, logs):
    session = _Session()
    del session.fs._rpc
    inst, _ = _instance(monkeypatch, session)
    assert 'cannot put a deadline on file calls' in inst.list_files({})['error'] and session.state == 'TERMINATED'


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    'args',
    [
        {},
        {'command': ''},
        {'command': '  '},
        {'command': 3},
        {'command': 'ls', 'cwd': 3},
        {'command': 'ls', 'cwd': '/tmp'},
    ],
)
def test_run_command_refuses_bad_input_without_touching_the_sandbox(monkeypatch, logs, args):
    inst, client = _instance(monkeypatch)
    with pytest.raises(ValueError):
        inst.run_command(args)
    assert client.created == []


def test_run_command_runs_a_login_shell_under_a_marker_of_its_own_with_the_timeout(monkeypatch, logs):
    session = _Session()
    inst, _ = _instance(monkeypatch, session, cfg={'exec_timeout_secs': 33})
    inst.run_command({'command': 'make', 'cwd': 'src/app'})
    inst.run_command({'command': 'ls'})
    assert session.commands() == [('bash', '-lc', 'cd /home/tenki/src/app || exit 1\nmake'), ('bash', '-lc', 'ls')]
    first, second = session.runs
    assert first.marker.startswith('TOOL_TENKI_RUN=') and first.marker != second.marker
    assert [call for call in session.calls if call[0] == 'start'][-1][2] == 33


_NEEDS_BASH = pytest.mark.skipif(sys.platform == 'win32' or not shutil.which('bash'), reason='runs in the Linux VM')


@_NEEDS_BASH
@pytest.mark.parametrize('command', ['true; echo ran', 'false || echo ran', 'true\necho ran'])
def test_a_cwd_that_does_not_exist_stops_the_whole_command(monkeypatch, logs, tmp_path, command):
    session = _Session()
    inst, _ = _instance(monkeypatch, session)
    inst.run_command({'command': command, 'cwd': 'no-such-folder'})
    ((_, _, script),) = session.commands()
    env = {**os.environ, 'LC_ALL': 'C'}  # bash's message in English
    done = subprocess.run(['bash', '-c', script], capture_output=True, text=True, timeout=60, cwd=tmp_path, env=env)
    assert (done.returncode, done.stdout) == (1, '')
    assert 'No such file or directory' in done.stderr


def test_a_command_result_reports_exit_code_output_and_timeout(monkeypatch, logs):
    result = _Result(argv=['bash'], exit_code=3, stdout=b'out', stderr=b'err', timed_out=True)
    inst, _ = _instance(monkeypatch, _Session(script=lambda argv: {'result': result}))
    assert inst.run_command({'command': 'x'}) == {
        'exit_code': 3,
        'stdout': 'out',
        'stderr': 'err',
        'timed_out': True,
        'truncated': False,
        'session': 'created',
    }


def test_both_streams_share_the_cap_and_stderr_keeps_half(monkeypatch, logs):
    result = _Result(argv=['bash'], stdout=b'o' * 5000, stderr=b'e' * 5000)
    inst, _ = _instance(monkeypatch, _Session(script=lambda argv: {'result': result}), cfg={'max_output_chars': 1000})
    output = inst.run_command({'command': 'x'})
    assert (len(output['stdout']), len(output['stderr']), output['truncated']) == (500, 500, True)


@pytest.mark.parametrize(
    ('process', 'timed_out', 'says'),
    [
        ({'stalls': True}, True, 'reported no result within 150s'),
        ({'start': 'stalls', 'pid': False}, False, 'did not start the command in time'),  # not its timeout (point F)
    ],
)
def test_a_command_with_no_start_or_no_result_in_time_is_cancelled(monkeypatch, logs, process, timed_out, says):
    session = _Session(script=lambda argv: process)
    inst, _ = _instance(monkeypatch, session)
    result = inst.run_command({'command': 'x'})
    assert (result['timed_out'], result['exit_code']) == (timed_out, -1) and says in result['error']
    assert ('kill', 'bash') in session.calls and len(session.commands()) == 1


def test_run_code_writes_the_code_to_a_fresh_file_runs_it_and_removes_it(monkeypatch, logs):
    session = _Session()
    inst, _ = _instance(monkeypatch, session)
    inst.run_code({'code': 'print(1)'})
    inst.run_code({'code': 'console.log(1)', 'language': 'javascript'})
    py, js = session.commands()
    assert py[:5] == ('bash', '-lc', 'exec "$@"', 'bash', 'python3') and py[5].endswith('.py')
    assert js[4] == 'node' and js[5].endswith('.js') and py[5] != js[5] and session.files == {}


@pytest.mark.parametrize(
    'args', [{}, {'code': ' '}, {'code': 'x', 'language': 'typescript'}, {'code': 'x', 'language': 3}]
)
def test_run_code_refuses_bad_input_without_touching_the_sandbox(monkeypatch, logs, args):
    inst, client = _instance(monkeypatch)
    with pytest.raises(ValueError):
        inst.run_code(args)
    assert client.created == []


def test_run_code_returns_its_result_even_if_the_cleanup_fails(monkeypatch, logs):
    inst, _ = _instance(monkeypatch, _Session(fail={'remove': mod.SandboxError('remove failed')}))
    assert inst.run_code({'code': 'print(1)'})['exit_code'] == 0


@pytest.mark.parametrize(
    ('tool', 'args'), [('run_command', {'command': 'git push'}), ('run_code', {'code': 'print(1)'})]
)
@pytest.mark.parametrize(
    'process',
    [
        {'run_error': mod.SessionTerminatedError(_CUT)},
        # Dylan's review of 67a0b2f6: the run failed right after its started frame, so close_stdin raised.
        {'start': mod.SessionTerminatedError(_CUT)},
    ],
    ids=['cut-mid-run', 'failed-right-after-start'],
)
def test_a_command_that_started_before_a_pause_is_not_run_again(monkeypatch, logs, tool, args, process):
    session = _pause_on_first_run(_Session(), **process)
    inst, client = _instance(monkeypatch, session)
    result = getattr(inst, tool)(args)
    assert len(session.commands()) == 1 and session.calls.count('resume') == 1
    assert (result['session'], result['exit_code'], result['timed_out']) == ('resumed', -1, False)
    assert 'cut off part-way and was not run again, so part of its work may be done' in result['error']
    assert inst.run_command({'command': 'ls'})['exit_code'] == 0 and len(client.created) == 1


@pytest.mark.parametrize(
    'retry',
    [
        {'run_error': mod.SessionTerminatedError(_CUT)},  # started by the retry and cut again (seen on a real VM)
        {'run_error': mod.PermissionDeniedError('data-plane credential expired')},  # an error that is not a pause
    ],
    ids=['cut-again', 'other-error'],
)
def test_a_started_command_whose_call_fails_any_other_way_says_part_of_its_work_may_be_done(monkeypatch, logs, retry):
    # Found in review of the rework: these came back as the bare error, so an agent could run the command again.
    session = _Session()
    inst, _ = _used(monkeypatch, session)
    session.state, session.script = 'PAUSED', lambda argv: retry
    result = inst.run_command({'command': 'make deploy'})
    assert result['session'] == 'resumed' and len(session.commands()) == 1
    assert 'while this command was running' in result['error'] and 'part of its work may be done' in result['error']


def test_a_command_a_paused_session_never_started_is_run_after_the_resume(monkeypatch, logs):
    session = _Session()
    inst, _ = _used(monkeypatch, session)
    session.state = 'PAUSED'
    result = inst.run_command({'command': 'make'})
    assert (result['exit_code'], result['session']) == (0, 'resumed') and len(session.commands()) == 1


def test_a_command_cut_off_by_an_ended_session_is_not_run_again_and_nothing_is_created(monkeypatch, logs):
    session = _Session()
    session.script = lambda argv: (
        setattr(session, 'state', 'TERMINATED') or {'run_error': mod.SessionTerminatedError(_CUT)}
    )
    inst, client = _instance(monkeypatch, session, _Session('sb-2'))
    result = inst.run_command({'command': 'deploy'})
    assert (
        result['session'] == 'ended' and 'Anything the command did outside the sandbox is still done' in result['error']
    )
    assert len(client.created) == 1


def test_a_started_command_whose_recovery_fails_says_part_of_its_work_may_be_done(monkeypatch, logs):
    monkeypatch.setattr(mod, '_RESUME_RETRY_SECS', 0.05)
    session = _pause_on_first_run(_Session(), run_error=mod.SessionTerminatedError(_CUT))
    session.resume_refusals = 10**6
    inst, _ = _instance(monkeypatch, session)
    result = inst.run_command({'command': 'git push'})
    assert 'the call lost the sandbox while this command was running (paused source' in result['error']


def test_a_denied_secret_injection_is_explained_and_other_output_left_alone(monkeypatch, logs):
    denied = _Result(argv=['bash'], stdout=b'{"error":"secret_injection_denied"}')
    inst, _ = _instance(monkeypatch, _Session(script=lambda argv: {'result': denied}))
    assert 'the policy is for the operator of this pipeline to change' in inst.run_command({'command': 'x'})['stderr']
    inst, _ = _instance(monkeypatch, _Session())
    assert inst.run_command({'command': 'x'})['stderr'] == ''


# ---------------------------------------------------------------------------
# The output limit, which bounds the engine's memory
# ---------------------------------------------------------------------------

_CHUNK = b'y' * 4096


@pytest.fixture
def small_limit(monkeypatch):
    monkeypatch.setattr(inst_mod, '_OUTPUT_LIMIT_BYTES', 64 * 1024)


def test_a_flooding_command_is_killed_by_its_marker_and_the_agent_told(monkeypatch, logs, small_limit):
    session = _Session(script=lambda argv: {'flood': (_CHUNK, 100 * 1024 * 1024)})
    inst, _ = _instance(monkeypatch, session, cfg={'max_output_chars': 1000})
    result = inst.run_command({'command': 'cat /dev/urandom | base64'})
    assert result['truncated'] is True and 'the command was killed before it finished' in result['stderr']
    assert session.runs[0].killed.is_set() and 'kill_tree' in session.calls and ('kill', 'bash') in session.calls


def test_a_finite_command_just_past_the_limit_is_cut_not_reported_killed(monkeypatch, logs, small_limit):
    session = _Session(script=lambda argv: {'flood': (_CHUNK, 80 * 1024)})
    session.kill_tree_report = 'found=0 killed=0 left=0'
    inst, _ = _instance(monkeypatch, session)
    stderr = inst.run_command({'command': 'cat big.log'})['stderr']
    assert 'could not confirm that it stopped the command' in stderr and 'killed before it finished' not in stderr


def test_a_flood_out_of_the_kills_reach_is_cut_and_logged_not_reported_killed(monkeypatch, logs, small_limit):
    monkeypatch.setattr(inst_mod, '_KILL_SETTLE_SECS', 0.05)
    # About 0.5 s of flood after the cut, so a kill that a busy runner slows still lands well before it ends.
    session = _Session(script=lambda argv: {'flood': (_CHUNK, 1024 * 1024), 'escapes': True})
    inst, _ = _instance(monkeypatch, session)
    result = inst.run_command({'command': 'sudo make'})
    assert 'could not confirm' in result['stderr'] and len(result['stdout']) <= 64 * 1024
    assert any("out of the kill's reach" in line for line in logs)


def test_a_kill_that_could_not_run_is_logged_and_the_sandboxs_kill_still_sent(monkeypatch, logs, small_limit):
    session = _Session(script=lambda argv: {'flood': (_CHUNK, 256 * 1024)})
    session.kill_tree_error = mod.SandboxError('start refused')
    inst, _ = _instance(monkeypatch, session)
    assert 'could not confirm' in inst.run_command({'command': 'yes'})['stderr'] and ('kill', 'bash') in session.calls
    assert any('could not stop all the processes' in line for line in logs)


def test_output_arriving_after_the_node_gave_up_on_a_command_is_not_kept(monkeypatch, logs):
    session = _Session(script=lambda argv: {'stalls': True})
    inst, _ = _instance(monkeypatch, session)
    inst.run_command({'command': 'x'})
    process = session.runs[0]
    process.stdout.push(b'late output')
    assert isinstance(process.stdout, shims.DiscardStream) and process.stdout.read() == b''


def _run_the_kill_script(tmp_path, processes, marker, survivors=()):
    """The kill script under bash over a fake /proc: its report, its exit code and the pids left."""
    proc = tmp_path / 'proc'
    for pid, environ in processes.items():
        (proc / str(pid)).mkdir(parents=True)
        (proc / str(pid) / 'environ').write_bytes(b''.join(entry.encode() + b'\0' for entry in environ))
    stub = (  # a bash function wins over the builtin: -KILL removes the pid, except a survivor's
        'kill() { [ -d "$FAKE_PROC/$2" ] || return 1; '
        'if [ "$1" = -KILL ]; then case " $SURVIVORS " in *" $2 "*) ;; *) rm -r "$FAKE_PROC/$2";; esac; fi; }'
    )
    script = f'{stub}\n' + inst_mod._KILL_TREE_SCRIPT.replace('/proc/', f'{proc}/')
    env = {**os.environ, 'FAKE_PROC': str(proc), 'SURVIVORS': ' '.join(map(str, survivors))}
    done = subprocess.run(['bash', '-c', script, 'k', marker], capture_output=True, text=True, timeout=60, env=env)
    return done.stdout.strip(), done.returncode, sorted(int(path.name) for path in proc.iterdir())


@_NEEDS_BASH
def test_the_kill_script_kills_only_the_commands_marked_processes(tmp_path):
    mine = 'TOOL_TENKI_RUN=aaaa'
    processes = {
        101: ['HOME=/home/tenki', mine],  # the command
        102: [mine],  # a background job it started
        201: ['TOOL_TENKI_RUN=bbbb'],  # another command's
        301: ['HOME=/home/tenki'],  # the sandbox's agent
        401: [f'NOTE={mine}', f'{mine}0'],  # the marker as a value, and a longer marker
        501: [],  # a zombie
    }
    assert _run_the_kill_script(tmp_path, processes, mine) == ('found=2 killed=2 left=0', 0, [201, 301, 401, 501])


@_NEEDS_BASH
def test_the_kill_script_exits_non_zero_when_a_marked_process_outlives_it(tmp_path):
    mine = 'TOOL_TENKI_RUN=aaaa'
    report = _run_the_kill_script(tmp_path, {101: [mine], 102: [mine]}, mine, [102])
    assert report == ('found=2 killed=1 left=1', 1, [102])


# ---------------------------------------------------------------------------
# Files
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ('given', 'resolved'),
    [
        ('a.txt', '/home/tenki/a.txt'),
        ('~/a', '/home/tenki/a'),
        ('~', '/home/tenki'),
        ('//home//tenki/./a/../b', '/home/tenki/b'),
    ],
)
def test_paths_resolve_under_home(given, resolved):
    assert inst_mod._normalize_path(given) == resolved


@pytest.mark.parametrize('given', ['/tmp/a', '../etc/passwd', '/home/tenkiX', '', None, 3])
def test_paths_outside_home_are_refused_with_a_message_naming_home(given):
    with pytest.raises(ValueError, match='/home/tenki|"path" is required'):
        inst_mod._normalize_path(given)


def test_write_file_writes_verbatim_and_creates_missing_parents(monkeypatch, logs):
    session = _Session()
    inst, _ = _instance(monkeypatch, session)
    text = 'line 1\r\n\ttabbed  \n'
    result = inst.write_file({'path': 'a/b/c.txt', 'content': text})
    assert result == {'success': True, 'path': '/home/tenki/a/b/c.txt', 'session': 'created'}
    assert session.files['/home/tenki/a/b/c.txt'] == text and '/home/tenki/a/b' in session.dirs


def test_write_file_refuses_content_read_file_could_not_read_back(monkeypatch, logs):
    # Dylan's review of 67a0b2f6. Measured 2026-10-26: Tenki took writes up to 16 MB, but reading 4.5 MB back failed
    # with QuotaExceededError ("Received message larger than max"), so a larger write could not be read back.
    inst, client = _instance(monkeypatch)
    with pytest.raises(ValueError, match='"content" is 4,000,002 bytes, more than the 4,000,000 write_file sends'):
        inst.write_file({'path': 'a', 'content': 'é' * 2_000_001})
    assert client.created == []


@pytest.mark.parametrize('args', [{'path': 'a'}, {'path': 'a', 'content': 3}, {'path': '/tmp/a', 'content': 'x'}])
def test_write_file_refuses_bad_input_without_touching_the_sandbox(monkeypatch, logs, args):
    inst, client = _instance(monkeypatch)
    with pytest.raises(ValueError):
        inst.write_file(args)
    assert client.created == []


def test_a_refused_path_is_explained(monkeypatch, logs):
    inst, _ = _instance(monkeypatch, _Session(fail={'write_file': mod.PermissionDeniedError('permission denied')}))
    assert inst.write_file({'path': 'a', 'content': 'x'})['error'] == (
        'permission denied (file operations are limited to paths under /home/tenki)'
    )


def test_edit_file_replaces_the_one_exact_occurrence(monkeypatch, logs):
    session = _Session(files={'/home/tenki/app.py': 'a = 1\r\nb = 1\n'})
    inst, _ = _instance(monkeypatch, session)
    assert inst.edit_file({'path': 'app.py', 'old_text': 'a = 1\r\n', 'new_text': ''})['success']
    assert session.files['/home/tenki/app.py'] == 'b = 1\n'


@pytest.mark.parametrize(
    ('text', 'old', 'new', 'says'),
    [
        ('x x', 'x', 'z', 'found 2 times'),
        ('aaa', 'aa', 'z', 'found 2 times'),  # overlapping matches count
        ('x', 'y', 'z', 'found 0 times'),
        ('x' * 4_000_001, 'x', 'z', 'more than the 4,000,000 edit_file reads'),
        ('a' + 'x' * 3_999_998, 'a', 'zzz', 'the edited file would be more than'),
        (None, 'x', 'z', 'no such file or directory: /home/tenki/f'),
    ],
    ids=['twice', 'overlapping', 'absent', 'too-big', 'would-grow-too-big', 'missing'],
)
def test_edit_file_refuses_and_writes_nothing(monkeypatch, logs, text, old, new, says):
    files = {} if text is None else {'/home/tenki/f': text}
    session = _Session(files=files)
    inst, _ = _instance(monkeypatch, session)
    result = inst.edit_file({'path': 'f', 'old_text': old, 'new_text': new})
    assert not result['success'] and says in result['error'] and session.files == files
    assert session.reads == ([] if says.startswith('more than') or text is None else ['/home/tenki/f'])


def test_edit_file_refuses_a_directory_and_text_that_is_not_utf8(monkeypatch, logs):
    session = _Session(dirs={'/home/tenki/d'}, files={'/home/tenki/b': 'x'})
    session.fs.read_bytes = lambda path: b'\xff\xfe'
    inst, _ = _instance(monkeypatch, session)
    assert 'is a directory' in inst.edit_file({'path': 'd', 'old_text': 'x', 'new_text': ''})['error']
    assert 'not UTF-8' in inst.edit_file({'path': 'b', 'old_text': 'x', 'new_text': ''})['error']


@pytest.mark.parametrize('args', [{'path': 'f', 'old_text': '', 'new_text': 'x'}, {'path': 'f', 'old_text': 'x'}])
def test_edit_file_refuses_bad_input_without_touching_the_sandbox(monkeypatch, logs, args):
    inst, client = _instance(monkeypatch)
    with pytest.raises(ValueError):
        inst.edit_file(args)
    assert client.created == []


def test_a_write_sent_with_an_edit_of_the_same_file_is_not_lost(monkeypatch, logs):
    # Dylan's review of 67a0b2f6: a write landing between an edit's read and its write was overwritten by the old
    # content plus the edit, and both calls reported success.
    session = _Session(files={'/home/tenki/app.py': 'a = 1\n'})
    inst, _ = _instance(monkeypatch, session)
    reading, written = threading.Event(), threading.Event()
    read_bytes = session.fs.read_bytes

    def slow_read(path):
        text = read_bytes(path)
        reading.set()
        written.wait(timeout=0.5)  # a write that is not held back lands here
        return text

    def write():
        reading.wait(timeout=5)
        result = inst.write_file({'path': 'app.py', 'content': 'rewritten\n'})
        written.set()
        return result

    session.fs.read_bytes = slow_read
    edit, write = _parallel(lambda: inst.edit_file({'path': 'app.py', 'old_text': 'a = 1', 'new_text': 'a = 2'}), write)
    assert edit['success'] and write['success'] and session.files['/home/tenki/app.py'] == 'rewritten\n'


def test_edits_of_different_files_run_together_and_edits_of_one_file_keep_both_changes(monkeypatch, logs):
    session = _Session(files={'/home/tenki/a': 'x = 1\ny = 1\n', '/home/tenki/b': 'z = 1\n'})
    inst, _ = _instance(monkeypatch, session)
    read_bytes = session.fs.read_bytes
    together = threading.Barrier(2, timeout=5)  # broken, failing both edits, if one waits for the other's lock

    def read_together(path):
        together.wait()
        return read_bytes(path)

    session.fs.read_bytes = read_together
    results = _parallel(
        lambda: inst.edit_file({'path': 'a', 'old_text': 'x = 1', 'new_text': 'x = 2'}),
        lambda: inst.edit_file({'path': 'b', 'old_text': 'z = 1', 'new_text': 'z = 2'}),
    )
    assert all(result['success'] for result in results), results
    both_read = threading.Barrier(2, timeout=0.5)  # without a lock, both edits of one file read before either writes

    def read_slowly(path):
        text = read_bytes(path)
        try:
            both_read.wait()
        except threading.BrokenBarrierError:
            pass
        return text

    session.fs.read_bytes = read_slowly
    edits = [{'path': 'a', 'old_text': old, 'new_text': old + '0'} for old in ('x = 2', 'y = 1')]
    _parallel(*[lambda args=args: inst.edit_file(args) for args in edits])
    assert session.files == {'/home/tenki/a': 'x = 20\ny = 10\n', '/home/tenki/b': 'z = 2\n'}


@pytest.mark.parametrize(
    ('tool', 'args', 'what'),
    [
        ('write_file', {'path': 'a', 'content': 'x'}, 'file write'),
        ('edit_file', {'path': 'a', 'old_text': 'o', 'new_text': 'n'}, 'edit'),
        ('make_directory', {'path': 'd'}, 'directory creation'),
        ('delete_path', {'path': 'a'}, 'delete'),
        ('git_checkout', {'ref': 'main'}, 'checkout'),
        ('git_clone', {'repo': 'https://github.com/o/r.git'}, 'clone'),
    ],
)
def test_a_change_in_flight_when_the_session_was_paused_is_not_sent_again(monkeypatch, logs, tool, args, what):
    session = _Session(files={'/home/tenki/a': 'o'})
    inst, _ = _used(monkeypatch, session)
    sent, enter = [], session.enter

    def pause_as_it_is_sent(operation):
        if operation in ('write_file', 'mkdir', 'remove', 'checkout', 'clone') and not sent:
            sent.append(operation)
            session.state = 'PAUSED'
        enter(operation)

    session.enter = pause_as_it_is_sent
    result = getattr(inst, tool)(args)
    assert result['session'] == 'resumed' and len(sent) == 1
    assert f'this {what} found the sandbox paused, and the sandbox has been resumed' in result['error']


def test_an_edit_paused_before_its_write_reads_again_and_edits_after_the_resume(monkeypatch, logs):
    session = _Session(files={'/home/tenki/a': 'old'})
    inst, _ = _used(monkeypatch, session)
    session.state = 'PAUSED'
    result = inst.edit_file({'path': 'a', 'old_text': 'old', 'new_text': 'new'})
    assert (result['success'], result['session']) == (True, 'resumed') and session.files['/home/tenki/a'] == 'new'


def test_read_file_checks_the_size_then_reads_the_text_and_cuts_it_by_characters(monkeypatch, logs):
    session = _Session(files={'/home/tenki/a': 'héllo ' * 500})
    inst, _ = _instance(monkeypatch, session, cfg={'max_output_chars': 1000})
    result = inst.read_file({'path': 'a'})
    assert (len(result['content']), result['truncated']) == (1000, True)
    assert [name for name, _ in session.deadlines] == ['stat', 'read_file']


@pytest.mark.parametrize(
    ('files', 'dirs', 'says'),
    [
        ({'/home/tenki/a': 'x' * 4_000_001}, (), 'more than the 4,000,000 read_file fetches'),
        ({}, ('/home/tenki/a',), 'is a directory; use list_files'),
        ({}, (), 'no such file or directory: /home/tenki/a'),
    ],
)
def test_read_file_refuses_without_fetching(monkeypatch, logs, files, dirs, says):
    session = _Session(files=files, dirs=dirs)
    inst, _ = _instance(monkeypatch, session)
    result = inst.read_file({'path': 'a'})
    assert says in result['error'] and result['content'] == '' and session.reads == []


def test_read_file_reads_a_file_exactly_at_the_limit(monkeypatch, logs):
    inst, _ = _instance(monkeypatch, _Session(files={'/home/tenki/a': 'x' * 4_000_000}), cfg={'max_output_chars': 1000})
    assert inst.read_file({'path': 'a'})['truncated'] is True


def test_list_files_lists_by_name_hides_dot_files_unless_asked_and_caps_the_listing(monkeypatch, logs):
    files = {'/home/tenki/b.txt': 'xy', '/home/tenki/.env': 'k'}
    inst, _ = _instance(monkeypatch, _Session(files=files, dirs={'/home/tenki/a'}))
    assert inst.list_files({})['entries'] == [
        {'name': 'a', 'is_dir': True, 'size': 0},
        {'name': 'b.txt', 'is_dir': False, 'size': 2},
    ]
    assert [entry['name'] for entry in inst.list_files({'include_hidden': True})['entries']] == ['.env', 'a', 'b.txt']
    assert inst.list_files({'path': 'nope'})['error'] == 'no such file or directory: /home/tenki/nope'
    many = _Session(files={f'/home/tenki/{i:04}': '' for i in range(200)})
    inst, _ = _instance(monkeypatch, many, cfg={'max_output_chars': 1000})
    listed = inst.list_files({})
    assert listed['truncated'] and len(json.dumps(listed['entries'])) <= 1000


def test_make_directory_and_delete_path(monkeypatch, logs):
    session = _Session()
    inst, _ = _instance(monkeypatch, session)
    assert inst.make_directory({'path': 'a/b'})['success'] and '/home/tenki/a/b' in session.dirs
    inst.write_file({'path': 'a/b/c', 'content': 'x'})
    assert inst.delete_path({'path': 'a'})['success'] and session.dirs == {'/home/tenki'} and session.files == {}
    assert inst.delete_path({'path': 'a'})['error'] == 'no such file or directory: /home/tenki/a'
    for home in ('/home/tenki', '~', '.'):
        with pytest.raises(ValueError, match='refusing to delete /home/tenki itself'):
            inst.delete_path({'path': home})


# ---------------------------------------------------------------------------
# Git
# ---------------------------------------------------------------------------


def test_git_arguments_are_stripped_absent_or_refused(monkeypatch, logs):
    session = _Session(git={'log': 'commit 1'})
    inst, _ = _instance(monkeypatch, session)
    assert inst.git_log({'range': ' main..fix ', 'path': '', 'directory': 'repo'})['output'] == 'commit 1'
    assert session.calls[-1] == (
        'log',
        {'max_count': 20, 'range': 'main..fix', 'path': None, 'directory': '/home/tenki/repo'},
    )
    for args in ({'ref': '--orphan'}, {'ref': ''}, {}, {'ref': 3}, {'ref': 'main', 'directory': '/tmp'}):
        with pytest.raises(ValueError):
            inst.git_checkout(args)
    with pytest.raises(ValueError, match='not both'):
        inst.git_diff({'range': 'a..b', 'base': 'a'})
    with pytest.raises(ValueError):
        inst.git_log({'max_count': 5000})


def test_git_checkout_and_diff_pass_their_arguments_through_and_are_capped(monkeypatch, logs):
    session = _Session(git={'diff': 'd' * 5000})
    inst, _ = _used(monkeypatch, session, cfg={'max_output_chars': 1000})
    inst.git_checkout({'ref': 'fix', 'create': True})
    assert session.calls[-1] == ('checkout', {'ref': 'fix', 'create': True, 'directory': None})
    assert inst.git_diff({'base': 'a', 'head': 'b', 'path': 'src'}) == {'output': 'd' * 1000, 'truncated': True}
    assert session.calls[-1] == ('diff', {'range': None, 'base': 'a', 'head': 'b', 'path': 'src', 'directory': None})


def test_git_errors_reach_the_agent_and_a_denied_injection_is_explained(monkeypatch, logs):
    denied = mod.SandboxError('remote: {"error":"secret_injection_denied"}')
    inst, _ = _instance(monkeypatch, _Session(fail={'checkout': mod.PermissionDeniedError('no'), 'diff': denied}))
    assert inst.git_checkout({'ref': 'x'})['error'] == 'no'
    assert 'the policy is for the operator' in inst.git_diff({})['error']


def test_git_clone_passes_its_arguments_through_into_a_folder_named_after_the_repository(monkeypatch, logs):
    session = _Session(git={'clone': "Cloning into 'Hello-World'..."})
    inst, _ = _instance(monkeypatch, session)
    repo = 'https://github.com/octocat/Hello-World.git'
    result = inst.git_clone({'repo': repo, 'branch': 'dev', 'depth': 1})
    assert result == {
        'directory': '/home/tenki/Hello-World',
        'output': "Cloning into 'Hello-World'...",
        'truncated': False,
        'session': 'created',
    }
    assert session.calls[-1][1] == {'repo': repo, 'branch': 'dev', 'depth': 1, 'directory': '/home/tenki/Hello-World'}
    with pytest.raises(ValueError, match='pass "directory"'):
        inst.git_clone({'repo': 'https://github.com/o/..'})


@pytest.mark.parametrize(
    'repo',
    [
        'git@github.com:o/r.git',
        'ssh://github.com/o/r',
        'file:///etc',
        'https://ghp_secret@github.com/o/r',
        'https://github.com/o/r?token=ghp_secret',
        'https://github.com/o/r#ghp_secret',
        'https:///o/r',
    ],
)
def test_git_clone_refuses_a_repository_url_it_cannot_or_must_not_clone(monkeypatch, logs, repo):
    inst, client = _instance(monkeypatch)
    with pytest.raises(ValueError, match='"repo" must') as refused:
        inst.git_clone({'repo': repo})
    assert 'ghp_secret' not in str(refused.value) and client.created == []


def test_git_clone_on_an_ended_session_clones_into_a_fresh_one(monkeypatch, logs):
    dead, fresh = _Session(), _Session('sb-2')
    inst, _ = _used(monkeypatch, dead, fresh)
    dead.state = 'TERMINATED'
    assert inst.git_clone({'repo': 'https://github.com/o/r'})['session'] == 'replaced' and fresh.calls[-1][0] == 'clone'


def _private(monkeypatch, process=None, **cfg):
    session = _Session(script=(lambda argv: process) if process else None)
    inst, _ = _instance(monkeypatch, session, cfg={**_PRIVATE, 'git_auth_url': 'https://github.com/acme/', **cfg})
    return inst, session


def test_a_clone_under_the_private_prefix_runs_git_with_only_the_placeholder(monkeypatch, logs):
    inst, session = _private(monkeypatch)
    result = inst.git_clone({'repo': 'https://github.com:443/acme/app.git', 'branch': 'main', 'depth': 2})
    assert result['directory'] == '/home/tenki/app' and 'error' not in result
    header = 'http.https://github.com/acme/.extraHeader=Authorization: Basic secrets://GITHUB_BASIC'
    assert session.commands() == [
        ('env', 'GIT_TERMINAL_PROMPT=0', 'git', 'clone', '--config', header, '--branch', 'main', '--depth', '2')
        + ('--', 'https://github.com:443/acme/app.git', '/home/tenki/app')
    ]


@pytest.mark.parametrize(
    'repo', ['https://github.com/acme-evil/app', 'https://github.com/other/app', 'http://github.com/acme/app']
)
def test_a_clone_outside_the_private_prefix_uses_tenkis_helper_without_a_credential(monkeypatch, logs, repo):
    inst, session = _private(monkeypatch)
    inst.git_clone({'repo': repo})
    assert session.commands() == [] and session.calls[-1][0] == 'clone'


@pytest.mark.parametrize(
    ('result', 'says'),
    [
        (_Result(['env'], 128, stderr=b'remote: secret_injection_denied'), 'git clone failed (exit code 128): remote'),
        (_Result(['env'], -1, timed_out=True), 'the clone did not finish within 120s'),
        (_Result(['env'], 1, stderr=b'e' * 5000), 'git clone failed (exit code 1): eee'),
    ],
    ids=['denied', 'timed-out', 'long'],
)
def test_a_failed_private_clone_returns_gits_output_to_the_agent(monkeypatch, logs, result, says):
    inst, _ = _private(monkeypatch, {'result': result}, max_output_chars=1000)
    output = inst.git_clone({'repo': 'https://github.com/acme/app'})
    assert says in output['error'] and output['output'] == ''
    assert ('the policy is for the operator' in output['error']) is (b'denied' in result.stderr)
    assert output['truncated'] is (len(result.stderr) > 1000)


def test_a_private_clone_killed_for_its_output_says_so_first(monkeypatch, logs, small_limit):
    inst, _ = _private(monkeypatch, {'flood': (_CHUNK, 100 * 1024 * 1024)})
    assert inst.git_clone({'repo': 'https://github.com/acme/app'})['error'].startswith(
        '[tool_tenki: the command was killed'
    )


def test_a_private_clone_a_paused_session_never_started_is_sent_after_the_resume(monkeypatch, logs):
    inst, session = _private(monkeypatch)
    inst.list_files({})
    session.state = 'PAUSED'
    assert inst.git_clone({'repo': 'https://github.com/acme/app'})['session'] == 'resumed'
    assert len(session.commands()) == 1


# ---------------------------------------------------------------------------
# What the agent and the editor are offered
# ---------------------------------------------------------------------------


def test_tool_descriptions_state_the_configured_limits_and_that_a_lifetime_pauses(monkeypatch, logs):
    inst, _ = _instance(monkeypatch, cfg={'exec_timeout_secs': 77, 'max_output_chars': 1234})
    tools = inst._collect_tool_methods()
    descriptions = {name: method.__tool_meta__['description'](inst) for name, method in tools.items()}
    assert 'Execution timeout: 77s.' in descriptions['run_command'] and '1234 characters' in descriptions['read_file']
    assert all('Tenki pauses a session that reaches its maximum lifetime' in text for text in descriptions.values())


def test_the_session_field_lists_every_value_the_node_reports():
    assert inst_mod._SESSION_EVENT['enum'] == ['created', 'resumed', 'replaced', 'ended']


def test_every_field_the_editor_offers_is_read_by_the_node_and_only_the_key_is_secret():
    source = (_NODES_SRC / 'nodes' / 'tool_tenki' / 'IGlobal.py').read_text()
    fields = _SERVICES['fields']
    assert [name for name in fields if f"'{name.removeprefix('tenki.')}'" not in source] == []
    assert [name for name, field in fields.items() if field.get('secure')] == ['tenki.apikey']
    arrays = {name for name, field in fields.items() if field['type'] == 'array'}
    assert arrays == {'tenki.secret_policies', 'tenki.allow_domains', 'tenki.toolGroups'}
    assert set(_SERVICES['shape'][0]['properties']) == {'type', *fields}
