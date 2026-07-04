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

"""
Daytona tool node instance.

Exposes ``run_code`` (execute code in the sandbox), ``run_command``
(execute a shell command), ``upload_file`` and ``download_file`` as agent
tools. All four operate on one shared, lazily created ephemeral sandbox.
"""

from __future__ import annotations

from rocketlib import IInstanceBase, tool_function

from ai.common.utils import normalize_tool_input

from daytona import DaytonaError, DaytonaNotFoundError

from .IGlobal import IGlobal

_SESSION_NOTE = (
    'The sandbox persists between calls (files, installed packages), but after '
    'sitting idle past the auto-stop interval it is recycled and a fresh empty '
    'one is created on the next call — re-upload/reinstall if that happens.'
)


def _truncate(text: str, cap: int) -> tuple[str, bool]:
    """Cap tool output so a chatty script cannot flood the agent context."""
    if text is None:
        return '', False
    text = str(text)
    if len(text) <= cap:
        return text, False
    return text[:cap], True


def _exec_result(response, cap: int) -> dict:
    """Shape a Daytona execution response into the tool output dict."""
    output, truncated = _truncate(getattr(response, 'result', ''), cap)
    exit_code = getattr(response, 'exit_code', None)
    try:
        exit_code = int(exit_code)
    except (TypeError, ValueError):
        exit_code = -1
    return {
        'exit_code': exit_code,
        'output': output,
        'truncated': truncated,
    }


class IInstance(IInstanceBase):
    IGlobal: IGlobal

    def _with_sandbox(self, call):
        """Run ``call(sandbox)``, recreating the sandbox once if it expired.

        The sandbox is ephemeral: after the inactivity auto-stop it is deleted
        server-side and every SDK call on the stale handle raises
        DaytonaNotFoundError. Drop the handle and retry once on a fresh
        sandbox so one idle gap doesn't brick the tool for the whole pipeline.
        """
        sandbox = self.IGlobal.get_sandbox()
        try:
            return call(sandbox)
        except DaytonaNotFoundError:
            self.IGlobal.drop_sandbox(sandbox)
            return call(self.IGlobal.get_sandbox())

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['code'],
            'properties': {
                'code': {
                    'type': 'string',
                    'description': 'Source code to execute in the sandbox. Use print() to produce output.',
                },
            },
        },
        output_schema={
            'type': 'object',
            'properties': {
                'exit_code': {'type': 'integer', 'description': 'Process exit code (0 = success).'},
                'output': {'type': 'string', 'description': 'Captured stdout/stderr of the execution.'},
                'truncated': {'type': 'boolean', 'description': 'True if output was cut at the configured cap.'},
                'error': {'type': 'string', 'description': 'Error message if the sandbox call failed.'},
            },
        },
        description=lambda self: (
            f'Execute code in a remote Daytona sandbox (isolated from this machine) and return its output. '
            f'{_SESSION_NOTE} '
            f'Sandbox language: {self.IGlobal.language}. Execution timeout: {self.IGlobal.exec_timeout_secs}s.'
        ),
    )
    def run_code(self, args):
        """Execute code in the shared Daytona sandbox."""
        args = normalize_tool_input(args, tool_name='daytona')
        code = args.get('code')
        if not code or not isinstance(code, str) or not code.strip():
            raise ValueError('"code" is required and must be a non-empty string')

        try:
            response = self._with_sandbox(
                lambda sandbox: sandbox.process.code_run(code, timeout=self.IGlobal.exec_timeout_secs)
            )
        except DaytonaError as e:
            return {'error': str(e), 'exit_code': -1, 'output': '', 'truncated': False}
        return _exec_result(response, self.IGlobal.max_output_chars)

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['command'],
            'properties': {
                'command': {
                    'type': 'string',
                    'description': 'Shell command to execute in the sandbox, e.g. "pip install requests && python app.py".',
                },
                'cwd': {
                    'type': 'string',
                    'description': 'Working directory inside the sandbox (optional).',
                },
            },
        },
        output_schema={
            'type': 'object',
            'properties': {
                'exit_code': {'type': 'integer', 'description': 'Command exit code (0 = success).'},
                'output': {'type': 'string', 'description': 'Captured stdout/stderr of the command.'},
                'truncated': {'type': 'boolean', 'description': 'True if output was cut at the configured cap.'},
                'error': {'type': 'string', 'description': 'Error message if the sandbox call failed.'},
            },
        },
        description=lambda self: (
            f'Run a shell command in the remote Daytona sandbox — install dependencies, build, then run. '
            f'{_SESSION_NOTE} Execution timeout: {self.IGlobal.exec_timeout_secs}s.'
        ),
    )
    def run_command(self, args):
        """Run a shell command in the shared Daytona sandbox."""
        args = normalize_tool_input(args, tool_name='daytona')
        command = args.get('command')
        if not command or not isinstance(command, str) or not command.strip():
            raise ValueError('"command" is required and must be a non-empty string')

        cwd = args.get('cwd')
        if cwd is not None and not isinstance(cwd, str):
            raise ValueError('"cwd" must be a string when provided')

        exec_kwargs = {'timeout': self.IGlobal.exec_timeout_secs}
        if cwd and cwd.strip():
            exec_kwargs['cwd'] = cwd.strip()

        try:
            response = self._with_sandbox(lambda sandbox: sandbox.process.exec(command, **exec_kwargs))
        except DaytonaError as e:
            return {'error': str(e), 'exit_code': -1, 'output': '', 'truncated': False}
        return _exec_result(response, self.IGlobal.max_output_chars)

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['path', 'content'],
            'properties': {
                'path': {
                    'type': 'string',
                    'description': 'Destination path inside the sandbox, e.g. "app/main.py".',
                },
                'content': {
                    'type': 'string',
                    'description': 'Text content to write to the file (UTF-8).',
                },
            },
        },
        output_schema={
            'type': 'object',
            'properties': {
                'success': {'type': 'boolean'},
                'path': {'type': 'string', 'description': 'Path the file was written to.'},
                'error': {'type': 'string', 'description': 'Error message if the upload failed.'},
            },
        },
        description='Write a text file into the Daytona sandbox (creates or overwrites).',
    )
    def upload_file(self, args):
        """Upload a text file into the shared sandbox."""
        args = normalize_tool_input(args, tool_name='daytona')
        path = args.get('path')
        if not path or not isinstance(path, str) or not path.strip():
            raise ValueError('"path" is required and must be a non-empty string')
        content = args.get('content')
        if content is None or not isinstance(content, str):
            raise ValueError('"content" is required and must be a string')

        path = path.strip()
        try:
            self._with_sandbox(lambda sandbox: sandbox.fs.upload_file(content.encode('utf-8'), path))
        except DaytonaError as e:
            return {'error': str(e), 'success': False, 'path': path}
        return {'success': True, 'path': path}

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['path'],
            'properties': {
                'path': {
                    'type': 'string',
                    'description': 'Path of the file to read from the sandbox.',
                },
            },
        },
        output_schema={
            'type': 'object',
            'properties': {
                'content': {'type': 'string', 'description': 'File content decoded as UTF-8.'},
                'truncated': {'type': 'boolean', 'description': 'True if content was cut at the configured cap.'},
                'error': {'type': 'string', 'description': 'Error message if the download failed.'},
            },
        },
        description='Read a text file from the Daytona sandbox.',
    )
    def download_file(self, args):
        """Download a text file from the shared sandbox."""
        args = normalize_tool_input(args, tool_name='daytona')
        path = args.get('path')
        if not path or not isinstance(path, str) or not path.strip():
            raise ValueError('"path" is required and must be a non-empty string')

        # No expired-sandbox retry here: a 404 on download is ambiguous between
        # "file missing" and "sandbox gone", and recreating an empty sandbox
        # cannot produce the file either way. run/upload calls recover the
        # session; this one just reports the miss.
        try:
            sandbox = self.IGlobal.get_sandbox()
            raw = sandbox.fs.download_file(path.strip())
        except DaytonaNotFoundError:
            return {
                'error': f'file not found (or the sandbox expired): {path.strip()}',
                'content': '',
                'truncated': False,
            }
        except DaytonaError as e:
            return {'error': str(e), 'content': '', 'truncated': False}

        if raw is None:
            return {'error': f'file not found: {path.strip()}', 'content': '', 'truncated': False}
        text = raw.decode('utf-8', errors='replace') if isinstance(raw, (bytes, bytearray)) else str(raw)
        content, truncated = _truncate(text, self.IGlobal.max_output_chars)
        return {'content': content, 'truncated': truncated}
