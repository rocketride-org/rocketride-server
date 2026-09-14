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
Tenki Sandbox tool node instance.

Exposes the agent tools, all operating on one shared, lazily created Tenki session.
Every tool is tagged with a tool group (see tool_groups.py), and only the groups named
in the ``tenki.toolGroups`` config field are published. Each tool reaches the session
through ``IGlobal.call_with_session``, which resumes a paused session and replaces a
terminated one.
"""

from __future__ import annotations

import posixpath
import shlex
import uuid
from typing import Callable

from rocketlib import IInstanceBase

from ai.common.utils import normalize_tool_input

from tenki import CommandTimeoutError, SandboxError

from .IGlobal import IGlobal
from .tool_groups import tenki_tool

#: The session's home and default working directory, and the only root Tenki's file API accepts.
_HOME = '/home/tenki'

# Tenki-specific on purpose. Daytona's sandbox is deleted when idle and comes back empty, but an
# idle Tenki session is paused: memory and /home/tenki survive, /tmp does not. An agent given
# Daytona's account would reinstall and re-clone for nothing, and not know to keep work out of /tmp.
_SESSION_NOTE = (
    'All Tenki Sandbox tools share one Linux VM, with /home/tenki as the home and working '
    'directory; files and installed packages persist between calls. An idle session is paused '
    'and resumed on the next call: memory and files under /home/tenki survive, but /tmp is '
    'cleared and open network connections drop, so keep work under /home/tenki. When the '
    'session reaches its maximum lifetime it is replaced by a fresh, empty one.'
)

#: run_code languages: the interpreter to run, and the file extension it expects.
_LANGUAGES = {
    'python': ('python3', '.py'),
    'javascript': ('node', '.js'),
    'typescript': ('ts-node', '.ts'),
}

_EXEC_OUTPUT_SCHEMA = {
    'type': 'object',
    'properties': {
        'exit_code': {
            'type': 'integer',
            'description': 'Process exit code (0 = success, -1 if the sandbox call failed).',
        },
        'stdout': {'type': 'string', 'description': 'Captured standard output.'},
        'stderr': {'type': 'string', 'description': 'Captured standard error.'},
        'timed_out': {
            'type': 'boolean',
            'description': 'True if the command was stopped at the execution timeout; the exit code can still be 0.',
        },
        'truncated': {'type': 'boolean', 'description': 'True if stdout or stderr was cut to fit the output cap.'},
        'error': {'type': 'string', 'description': 'Error message if the sandbox call failed.'},
    },
}


def _truncate(text: str, cap: int) -> tuple[str, bool]:
    """Cap tool output so a chatty script cannot flood the agent context."""
    if text is None:
        return '', False
    text = str(text)
    if len(text) <= cap:
        return text, False
    return text[:cap], True


def _exec_result(result, cap: int) -> dict:
    """Shape a Tenki CommandResult into the tool output, with ``cap`` shared by both streams.

    Errors usually land on stderr, so a flood on stdout must not push them out: stderr may
    always keep up to half of the cap, and either stream may use whatever the other leaves.
    """
    stdout_text, stderr_text = result.stdout_text, result.stderr_text
    stderr, stderr_cut = _truncate(stderr_text, max(cap // 2, cap - len(stdout_text)))
    stdout, stdout_cut = _truncate(stdout_text, cap - len(stderr))
    return {
        'exit_code': result.exit_code,
        'stdout': stdout,
        'stderr': stderr,
        'timed_out': bool(result.timed_out),
        'truncated': stdout_cut or stderr_cut,
    }


def _exec_error(error: SandboxError) -> dict:
    """Shape a failed sandbox call into the tool output."""
    return {
        'error': str(error),
        'exit_code': -1,
        'stdout': '',
        'stderr': '',
        # A command stopped at its timeout comes back as a result with timed_out set; this is
        # the other path, where the call itself ran past the deadline.
        'timed_out': isinstance(error, CommandTimeoutError),
        'truncated': False,
    }


class IInstance(IInstanceBase):
    IGlobal: IGlobal

    def _collect_tool_methods(self) -> dict[str, Callable]:
        """Publish only the tools whose group is enabled in ``tenki.toolGroups``.

        Filtering here covers ``tool.query`` (the agent never sees the tool) and
        ``tool.invoke`` (calling it anyway is refused) alike. A tool without a group is never
        published, so a missing tag fails closed instead of widening what an agent can reach.
        """
        enabled = self.IGlobal.tool_groups
        return {
            name: method
            for name, method in super()._collect_tool_methods().items()
            if getattr(getattr(type(self), name, None), '__tenki_group__', None) in enabled
        }

    # -----------------------------------------------------------------------
    # Group: execution
    #
    # Both tools run through a bash login shell. Tenki's base image installs node with nvm,
    # which puts it on PATH through the shell's startup files, and Tenki's own shell helper
    # runs commands the same way.
    # -----------------------------------------------------------------------

    @tenki_tool(
        group='execution',
        input_schema={
            'type': 'object',
            'required': ['command'],
            'properties': {
                'command': {
                    'type': 'string',
                    'description': 'Shell command to run with bash, e.g. "pip install requests && python app.py".',
                },
                'cwd': {
                    'type': 'string',
                    'description': 'Directory to run in (optional); a relative path resolves against /home/tenki.',
                },
            },
        },
        output_schema=_EXEC_OUTPUT_SCHEMA,
        description=lambda self: (
            'Run a shell command in the remote Tenki sandbox (isolated from this machine): install '
            'dependencies, build, run tests. On the default image commands run as user tenki with '
            'passwordless sudo, so install system packages with sudo apt-get. The call waits until '
            "the command's output streams close, so start a long-running server in the background "
            'with its output redirected, e.g. "python3 -m http.server 3000 >/home/tenki/server.log '
            '2>&1 </dev/null &". '
            f'{_SESSION_NOTE} Execution timeout: {self.IGlobal.exec_timeout_secs}s.'
        ),
    )
    def run_command(self, args):
        """Run a shell command in the shared Tenki session."""
        args = normalize_tool_input(args, tool_name='tenki')
        command = args.get('command')
        if not command or not isinstance(command, str) or not command.strip():
            raise ValueError('"command" is required and must be a non-empty string')

        cwd = args.get('cwd')
        if cwd is not None and not isinstance(cwd, str):
            raise ValueError('"cwd" must be a string when provided')

        if cwd and cwd.strip():
            # Changed inside the script rather than passed as exec's cwd: a login shell runs the
            # guest's startup files first, and a cd in them would win over exec's cwd.
            command = f'cd {shlex.quote(posixpath.join(_HOME, cwd.strip()))} && {command}'

        try:
            result = self.IGlobal.call_with_session(
                lambda session: session.exec('bash', '-lc', command, timeout=self.IGlobal.exec_timeout_secs)
            )
        except SandboxError as e:
            return _exec_error(e)
        return _exec_result(result, self.IGlobal.max_output_chars)

    @tenki_tool(
        group='execution',
        input_schema={
            'type': 'object',
            'required': ['code'],
            'properties': {
                'code': {
                    'type': 'string',
                    'description': 'Source code to execute. Print what you need to see: only stdout and stderr come back.',
                },
                'language': {
                    'type': 'string',
                    'enum': sorted(_LANGUAGES),
                    'description': (
                        'Language of the code: python (python3), javascript (node) or typescript (ts-node). '
                        'Defaults to python.'
                    ),
                },
            },
        },
        output_schema=_EXEC_OUTPUT_SCHEMA,
        description=lambda self: (
            'Execute a code snippet in the remote Tenki sandbox (isolated from this machine) and return '
            'its output. The code is saved to a temporary file under /home/tenki, run, and the file is '
            'removed afterwards. '
            f'{_SESSION_NOTE} Execution timeout: {self.IGlobal.exec_timeout_secs}s.'
        ),
    )
    def run_code(self, args):
        """Execute a code snippet in the shared Tenki session."""
        args = normalize_tool_input(args, tool_name='tenki')
        code = args.get('code')
        if not code or not isinstance(code, str) or not code.strip():
            raise ValueError('"code" is required and must be a non-empty string')

        language = args.get('language') or 'python'
        if language not in _LANGUAGES:
            raise ValueError(f'"language" must be one of: {", ".join(sorted(_LANGUAGES))}')
        interpreter, extension = _LANGUAGES[language]
        # A fresh name per call: parallel calls share the session, and a fixed name would let
        # one call overwrite the file another is about to run.
        path = f'{_HOME}/.tenki-run-{uuid.uuid4().hex}{extension}'

        def run(session):
            # Tenki has no code-run primitive. The code goes in through the file API instead of a
            # shell heredoc, whose escaping would mangle multi-line code.
            session.fs.write_text(path, code)
            try:
                # "$@" hands the interpreter and path to exec as separate arguments, unquoted.
                return session.exec(
                    'bash', '-lc', 'exec "$@"', 'bash', interpreter, path, timeout=self.IGlobal.exec_timeout_secs
                )
            finally:
                try:
                    session.fs.remove(path)
                except Exception:
                    # Best effort: a leftover file under /home/tenki is harmless, and failing
                    # here would hide the result (or the real error) of the run itself.
                    pass

        try:
            result = self.IGlobal.call_with_session(run)
        except SandboxError as e:
            return _exec_error(e)
        return _exec_result(result, self.IGlobal.max_output_chars)
