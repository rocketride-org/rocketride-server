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

"""Mock Daytona SDK for node testing — no real sandboxes are created."""

from __future__ import annotations


class DaytonaError(Exception):
    """Mirror of daytona.DaytonaError."""


class DaytonaNotFoundError(DaytonaError):
    """Mirror of daytona.DaytonaNotFoundError (404)."""


class DaytonaConfig:
    def __init__(self, api_key=None, api_url=None, target=None, **kwargs):
        self.api_key = api_key
        self.api_url = api_url
        self.target = target


class CreateSandboxFromSnapshotParams:
    def __init__(self, snapshot=None, language=None, ephemeral=False, auto_stop_interval=None, **kwargs):
        self.snapshot = snapshot
        self.language = language
        self.ephemeral = ephemeral
        self.auto_stop_interval = auto_stop_interval


class _MockExecResponse:
    def __init__(self, result='', exit_code=0):
        self.result = result
        self.exit_code = exit_code


class _MockProcess:
    def code_run(self, code, timeout=None, **kwargs):
        return _MockExecResponse(result=f'mock code_run output ({len(code)} chars)')

    def exec(self, command, cwd=None, timeout=None, env=None, **kwargs):
        return _MockExecResponse(result=f'mock exec output: {command}')


class _MockFileSystem:
    def __init__(self):
        self._files = {}

    def upload_file(self, content, path, **kwargs):
        self._files[path] = bytes(content)

    def download_file(self, path, **kwargs):
        if path not in self._files:
            raise DaytonaNotFoundError(f'mock: file not found: {path}')
        return self._files[path]


class _MockSandbox:
    def __init__(self, params=None):
        self.id = 'mock-sandbox-id'
        self.params = params
        self.process = _MockProcess()
        self.fs = _MockFileSystem()
        self.deleted = False

    def delete(self):
        self.deleted = True


Sandbox = _MockSandbox


class Daytona:
    def __init__(self, config=None):
        self.config = config

    def create(self, params=None, **kwargs):
        return _MockSandbox(params)


__all__ = [
    'CreateSandboxFromSnapshotParams',
    'Sandbox',
    'Daytona',
    'DaytonaConfig',
    'DaytonaError',
    'DaytonaNotFoundError',
]
