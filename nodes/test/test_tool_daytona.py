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

"""Unit tests for tool_daytona helpers and tool-method validation (no network)."""

from __future__ import annotations

import importlib
import sys
from pathlib import Path
from unittest.mock import MagicMock

import pytest

# ---------------------------------------------------------------------------
# Bootstrap: when run under a bare interpreter that lacks the engine runtime
# (rocketlib, ai.common, the daytona SDK), inject lightweight stubs ONLY for
# modules that are not already present, import the module under test, then
# REMOVE the stubs we added so they never leak into the shared pytest session
# (see test_tool_tavily.py for the full rationale).
# ---------------------------------------------------------------------------

_NODES_SRC = Path(__file__).resolve().parents[1] / 'src'
if str(_NODES_SRC) not in sys.path:
    sys.path.insert(0, str(_NODES_SRC))


class _StubDaytonaError(Exception):
    """Real exception class so IInstance's except clauses catch it under the stub."""


class _StubDaytonaNotFoundError(_StubDaytonaError):
    """Mirror of the SDK hierarchy: NotFound subclasses DaytonaError."""


def _build_import_stubs():
    """Return {module_name: stub} for the deps needed only to import the module."""
    rocketlib = MagicMock()
    rocketlib.IInstanceBase = object
    rocketlib.IGlobalBase = object
    rocketlib.tool_function = lambda **kwargs: lambda f: f
    rocketlib.debug = lambda *a, **kw: None
    rocketlib.error = lambda *a, **kw: None
    rocketlib.warning = lambda *a, **kw: None
    rocketlib.OPEN_MODE = MagicMock()

    depends = MagicMock()
    depends.depends = lambda *a, **kw: None

    ai_common_utils = MagicMock()
    ai_common_utils.normalize_tool_input = lambda args, **kw: args if isinstance(args, dict) else {}

    daytona = MagicMock()
    daytona.DaytonaError = _StubDaytonaError
    daytona.DaytonaNotFoundError = _StubDaytonaNotFoundError
    daytona.Daytona = MagicMock()
    daytona.DaytonaConfig = MagicMock()
    daytona.CreateSandboxFromSnapshotParams = MagicMock()

    return {
        'rocketlib': rocketlib,
        'depends': depends,
        'ai': MagicMock(),
        'ai.common': MagicMock(),
        'ai.common.utils': ai_common_utils,
        'ai.common.config': MagicMock(),
        'daytona': daytona,
    }


_added_stubs = []
for _name, _stub in _build_import_stubs().items():
    if _name not in sys.modules:
        sys.modules[_name] = _stub
        _added_stubs.append(_name)

mod = importlib.import_module('nodes.tool_daytona.IInstance')

for _name in _added_stubs:
    sys.modules.pop(_name, None)


class _FakeResponse:
    def __init__(self, result='', exit_code=0):
        self.result = result
        self.exit_code = exit_code


class _FakeProcess:
    def __init__(self, response=None, raise_error=None):
        self._response = response or _FakeResponse()
        self._raise = raise_error
        self.calls = []

    def code_run(self, code, **kwargs):
        self.calls.append(('code_run', code, kwargs))
        if self._raise:
            raise self._raise
        return self._response

    def exec(self, command, **kwargs):
        self.calls.append(('exec', command, kwargs))
        if self._raise:
            raise self._raise
        return self._response


class _FakeSandbox:
    def __init__(self, process):
        self.process = process


class _FakeGlobal:
    def __init__(self, sandbox, *, exec_timeout_secs=120, max_output_chars=1000, language='python', next_sandbox=None):
        self._sandbox = sandbox
        self._next_sandbox = next_sandbox
        self.exec_timeout_secs = exec_timeout_secs
        self.max_output_chars = max_output_chars
        self.language = language
        self.get_sandbox_calls = 0
        self.dropped = []

    def get_sandbox(self):
        self.get_sandbox_calls += 1
        if self._sandbox is None and self._next_sandbox is not None:
            self._sandbox = self._next_sandbox
        return self._sandbox

    def drop_sandbox(self, sandbox):
        self.dropped.append(sandbox)
        if self._sandbox is sandbox:
            self._sandbox = None


def _instance(global_state):
    inst = mod.IInstance()
    inst.IGlobal = global_state
    return inst


# ---------------------------------------------------------------------------
# Pure helpers
# ---------------------------------------------------------------------------


def test_truncate_below_cap_passes_through():
    text, truncated = mod._truncate('short', 100)
    assert text == 'short'
    assert truncated is False


def test_truncate_above_cap_cuts_and_flags():
    text, truncated = mod._truncate('x' * 150, 100)
    assert len(text) == 100
    assert truncated is True


def test_truncate_none_is_empty():
    text, truncated = mod._truncate(None, 100)
    assert text == ''
    assert truncated is False


def test_exec_result_coerces_bad_exit_code():
    shaped = mod._exec_result(_FakeResponse(result='ok', exit_code='not-an-int'), 100)
    assert shaped == {'exit_code': -1, 'output': 'ok', 'truncated': False}


# ---------------------------------------------------------------------------
# Tool-method validation: no sandbox call may happen on invalid input
# ---------------------------------------------------------------------------


def test_run_code_rejects_empty_code_without_touching_sandbox():
    glb = _FakeGlobal(_FakeSandbox(_FakeProcess()))
    inst = _instance(glb)
    with pytest.raises(ValueError):
        inst.run_code({'code': '   '})
    assert glb.get_sandbox_calls == 0


def test_run_command_rejects_non_string_cwd_without_touching_sandbox():
    glb = _FakeGlobal(_FakeSandbox(_FakeProcess()))
    inst = _instance(glb)
    with pytest.raises(ValueError):
        inst.run_command({'command': 'ls', 'cwd': 42})
    assert glb.get_sandbox_calls == 0


def test_run_command_passes_timeout_and_strips_cwd():
    process = _FakeProcess(_FakeResponse(result='done', exit_code=0))
    glb = _FakeGlobal(_FakeSandbox(process), exec_timeout_secs=7)
    inst = _instance(glb)
    out = inst.run_command({'command': 'ls', 'cwd': '  /app  '})
    assert out == {'exit_code': 0, 'output': 'done', 'truncated': False}
    _, _, kwargs = process.calls[0]
    assert kwargs == {'timeout': 7, 'cwd': '/app'}


def test_run_code_returns_error_dict_on_daytona_error():
    process = _FakeProcess(raise_error=mod.DaytonaError('boom'))
    glb = _FakeGlobal(_FakeSandbox(process))
    inst = _instance(glb)
    out = inst.run_code({'code': 'print(1)'})
    assert out['error'] == 'boom'
    assert out['exit_code'] == -1


def test_run_code_truncates_long_output():
    process = _FakeProcess(_FakeResponse(result='y' * 5000, exit_code=0))
    glb = _FakeGlobal(_FakeSandbox(process), max_output_chars=1000)
    inst = _instance(glb)
    out = inst.run_code({'code': 'print(1)'})
    assert len(out['output']) == 1000
    assert out['truncated'] is True


# ---------------------------------------------------------------------------
# Expired-sandbox recovery
# ---------------------------------------------------------------------------


def test_run_code_recreates_sandbox_once_on_not_found():
    dead = _FakeSandbox(_FakeProcess(raise_error=mod.DaytonaNotFoundError('sandbox gone')))
    fresh_process = _FakeProcess(_FakeResponse(result='recovered', exit_code=0))
    glb = _FakeGlobal(dead, next_sandbox=_FakeSandbox(fresh_process))
    inst = _instance(glb)
    out = inst.run_code({'code': 'print(1)'})
    assert out == {'exit_code': 0, 'output': 'recovered', 'truncated': False}
    assert glb.dropped == [dead]
    assert glb.get_sandbox_calls == 2


def test_run_code_gives_up_after_one_recreate():
    dead = _FakeSandbox(_FakeProcess(raise_error=mod.DaytonaNotFoundError('gone')))
    also_dead = _FakeSandbox(_FakeProcess(raise_error=mod.DaytonaNotFoundError('still gone')))
    glb = _FakeGlobal(dead, next_sandbox=also_dead)
    inst = _instance(glb)
    out = inst.run_code({'code': 'print(1)'})
    assert out['error'] == 'still gone'
    assert glb.dropped == [dead]


def test_download_file_does_not_recreate_on_not_found():
    class _Fs:
        def download_file(self, path):
            raise mod.DaytonaNotFoundError('404')

    sandbox = _FakeSandbox(_FakeProcess())
    sandbox.fs = _Fs()
    glb = _FakeGlobal(sandbox)
    inst = _instance(glb)
    out = inst.download_file({'path': 'a.txt'})
    assert 'file not found' in out['error']
    assert glb.dropped == []


# ---------------------------------------------------------------------------
# upload_file / download_file
# ---------------------------------------------------------------------------


class _FakeFs:
    def __init__(self):
        self.files = {}

    def upload_file(self, content, path):
        self.files[path] = bytes(content)

    def download_file(self, path):
        if path not in self.files:
            raise mod.DaytonaNotFoundError(f'404: {path}')
        return self.files[path]


def test_upload_file_encodes_utf8_and_reports_path():
    sandbox = _FakeSandbox(_FakeProcess())
    sandbox.fs = _FakeFs()
    glb = _FakeGlobal(sandbox)
    inst = _instance(glb)
    out = inst.upload_file({'path': '  app/main.py  ', 'content': 'print("привет")'})
    assert out == {'success': True, 'path': 'app/main.py'}
    assert sandbox.fs.files['app/main.py'] == 'print("привет")'.encode('utf-8')


def test_upload_file_rejects_missing_content_without_touching_sandbox():
    glb = _FakeGlobal(_FakeSandbox(_FakeProcess()))
    inst = _instance(glb)
    with pytest.raises(ValueError):
        inst.upload_file({'path': 'a.txt'})
    assert glb.get_sandbox_calls == 0


def test_download_file_decodes_and_truncates():
    sandbox = _FakeSandbox(_FakeProcess())
    sandbox.fs = _FakeFs()
    sandbox.fs.files['big.txt'] = ('я' * 2000).encode('utf-8')
    glb = _FakeGlobal(sandbox, max_output_chars=1000)
    inst = _instance(glb)
    out = inst.download_file({'path': 'big.txt'})
    assert len(out['content']) == 1000
    assert out['truncated'] is True
