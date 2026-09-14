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

import json
import posixpath
import re
import shlex
import uuid
from typing import Callable

from rocketlib import IInstanceBase

from ai.common.utils import normalize_tool_input, optional_bool, optional_int

from tenki import CommandTimeoutError, PermissionDeniedError, SandboxError
from tenki import FileNotFoundError as TenkiFileNotFoundError  # also subclasses the builtin it shadows

from .IGlobal import IGlobal, SessionEndedError
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

_PATH_NOTE = (
    'Paths are relative to /home/tenki or absolute under it; anything outside /home/tenki, including /tmp, is rejected.'
)

#: git_log's commit count when none is given, and the most it accepts. The whole log comes back
#: in one response, so an unbounded log of a large repository would sit in memory in full before
#: it could be truncated.
_DEFAULT_LOG_COUNT = 20
_MAX_LOG_COUNT = 1000

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


_CHANGE_OUTPUT_SCHEMA = {
    'type': 'object',
    'properties': {
        'success': {'type': 'boolean'},
        'path': {'type': 'string', 'description': 'Absolute path in the sandbox.'},
        'error': {'type': 'string', 'description': 'Error message if the operation failed.'},
    },
}


def _normalize_path(path) -> str:
    """Resolve an agent-supplied path to an absolute path under /home/tenki.

    Tenki's file API accepts nothing outside /home/tenki, including /tmp, and refuses it with a
    bare permission error. Agents reach for /tmp first, so paths are checked here instead, and
    refused with a message that says where files belong. Relative paths, and ``~``, resolve
    against /home/tenki. This is a usability check, not a security boundary: run_command can
    reach the whole VM anyway.

    Raises:
        ValueError: If ``path`` is empty or resolves outside /home/tenki.
    """
    if not isinstance(path, str) or not path.strip():
        raise ValueError('"path" is required and must be a non-empty string')
    given = path.strip()
    if given == '~' or given.startswith('~/'):
        given = _HOME + given[1:]
    # Slash runs collapsed first, because normpath keeps a leading '//'.
    resolved = posixpath.normpath(re.sub(r'/+', '/', posixpath.join(_HOME, given)))
    if resolved != _HOME and not resolved.startswith(_HOME + '/'):
        raise ValueError(f'paths must be under /home/tenki (relative paths resolve there), but {given!r} is outside it')
    return resolved


def _fs_error(error: Exception, path: str) -> str:
    """A readable message for a failed file operation."""
    if isinstance(error, TenkiFileNotFoundError):
        return f'no such file or directory: {path}'
    if isinstance(error, PermissionDeniedError):
        return f'{error} (file operations are limited to paths under /home/tenki)'
    return str(error)


def _listing(entries, cap: int) -> tuple[list[dict], bool]:
    """Shape directory entries by name, stopping before the listing's JSON would pass ``cap``."""
    shaped, used = [], 2  # the enclosing brackets
    # In a listing, a FileInfo's path holds the entry's name.
    for entry in sorted(entries, key=lambda info: info.path):
        item = {'name': entry.path, 'is_dir': bool(entry.is_dir), 'size': int(entry.size)}
        used += len(json.dumps(item)) + 2  # the entry and its separator
        if used > cap:
            return shaped, True
        shaped.append(item)
    return shaped, False


_GIT_OUTPUT_SCHEMA = {
    'type': 'object',
    'properties': {
        'output': {'type': 'string', 'description': "git's output."},
        'truncated': {'type': 'boolean', 'description': 'True if the output was cut at the output cap.'},
        'error': {'type': 'string', 'description': 'Error message if the git operation failed.'},
    },
}

_REPO_DIRECTORY = {
    'type': 'string',
    'description': (
        "The repository's folder (the equivalent of git -C), relative to /home/tenki or absolute "
        'under it. Defaults to /home/tenki.'
    ),
}


def _git_arg(args: dict, key: str, *, required: bool = False) -> str | None:
    """Return a stripped git argument from the tool input, or None when optional and not given.

    A value starting with '-' is refused: git would read it as an option rather than as the
    repository, ref or path it was meant to be, and none of those legitimately starts that way.
    """
    value = args.get(key)
    if value is None or (not required and isinstance(value, str) and not value.strip()):
        if required:
            raise ValueError(f'"{key}" is required and must be a non-empty string')
        return None
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f'"{key}" must be a non-empty string')
    value = value.strip()
    if value.startswith('-'):
        raise ValueError(f'"{key}" must not start with "-", which git would read as an option')
    return value


def _git_directory(args: dict) -> str | None:
    """The repository folder from the tool input, resolved under /home/tenki, or None if not given."""
    directory = args.get('directory')
    if directory is None or (isinstance(directory, str) and not directory.strip()):
        return None
    if not isinstance(directory, str):
        raise ValueError('"directory" must be a string')
    return _normalize_path(directory)


def _clone_folder(repo: str) -> str | None:
    """The folder name git itself clones ``repo`` into: its last path segment, without ``.git``."""
    name = repo.rstrip('/').rsplit('/', 1)[-1].rsplit(':', 1)[-1]
    if name.endswith('.git'):
        name = name[: -len('.git')]
    return None if name in ('', '.', '..') else name


def _git_result(output, cap: int) -> dict:
    text, truncated = _truncate(output, cap)
    return {'output': text, 'truncated': truncated}


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

    # -----------------------------------------------------------------------
    # Group: filesystem
    #
    # Every path goes through _normalize_path before any call. Reads, listings and deletes pass
    # replace=False: if the session has ended, a fresh, empty one cannot contain what they look
    # for, so creating one would only add cost.
    # -----------------------------------------------------------------------

    @tenki_tool(
        group='filesystem',
        input_schema={
            'type': 'object',
            'required': ['path', 'content'],
            'properties': {
                'path': {'type': 'string', 'description': 'File to write, e.g. "app/main.py".'},
                'content': {'type': 'string', 'description': 'Text to write (UTF-8); it replaces the whole file.'},
            },
        },
        output_schema=_CHANGE_OUTPUT_SCHEMA,
        description=lambda self: (
            'Write a text file in the remote Tenki sandbox, creating it or replacing its content, '
            f'along with any missing parent directories. {_PATH_NOTE} {_SESSION_NOTE}'
        ),
    )
    def write_file(self, args):
        """Write a text file in the shared Tenki session."""
        args = normalize_tool_input(args, tool_name='tenki')
        path = _normalize_path(args.get('path'))
        content = args.get('content')
        if not isinstance(content, str):
            raise ValueError('"content" is required and must be a string')

        def write(session):
            try:
                session.fs.write_text(path, content)
            except TenkiFileNotFoundError:
                # The parent directory is missing: create it, with its own parents, and write again.
                session.fs.mkdir(posixpath.dirname(path))
                session.fs.write_text(path, content)

        try:
            self.IGlobal.call_with_session(write)
        except SandboxError as e:
            return {'success': False, 'path': path, 'error': _fs_error(e, path)}
        return {'success': True, 'path': path}

    @tenki_tool(
        group='filesystem',
        input_schema={
            'type': 'object',
            'required': ['path'],
            'properties': {
                'path': {'type': 'string', 'description': 'File to read, e.g. "app/main.py".'},
            },
        },
        output_schema={
            'type': 'object',
            'properties': {
                'path': {'type': 'string', 'description': 'Absolute path in the sandbox.'},
                'content': {'type': 'string', 'description': 'File content decoded as UTF-8.'},
                'truncated': {'type': 'boolean', 'description': 'True if the content was cut at the output cap.'},
                'error': {'type': 'string', 'description': 'Error message if the file could not be read.'},
            },
        },
        description=lambda self: (
            'Read a text file from the remote Tenki sandbox, decoded as UTF-8. At most '
            f'{self.IGlobal.max_output_chars} characters are returned. {_PATH_NOTE} {_SESSION_NOTE}'
        ),
    )
    def read_file(self, args):
        """Read a text file from the shared Tenki session."""
        args = normalize_tool_input(args, tool_name='tenki')
        path = _normalize_path(args.get('path'))
        cap = self.IGlobal.max_output_chars
        # UTF-8 spends at most 4 bytes on a character. Reading that many bytes per character, plus
        # one, returns the whole file whenever it fits in `cap` characters, and more than `cap`
        # characters whenever it does not, so truncation is still detected.
        limit = cap * 4 + 1

        def read(session):
            stream = session.fs.read_stream(path, length=limit)
            data = bytearray()
            try:
                # Bounded here as well as by length: a multi-gigabyte file must never be pulled
                # whole into the engine's memory, whatever the service does with the hint.
                for chunk in stream:
                    data += chunk
                    if len(data) >= limit:
                        break
            finally:
                close = getattr(stream, 'close', None)
                if callable(close):
                    close()
            return bytes(data[:limit])

        try:
            data = self.IGlobal.call_with_session(read, replace=False)
        except (SandboxError, SessionEndedError) as e:
            return {'path': path, 'content': '', 'truncated': False, 'error': _fs_error(e, path)}
        content, truncated = _truncate(data.decode('utf-8', errors='replace'), cap)
        return {'path': path, 'content': content, 'truncated': truncated}

    @tenki_tool(
        group='filesystem',
        input_schema={
            'type': 'object',
            'properties': {
                'path': {'type': 'string', 'description': 'Directory to list. Defaults to /home/tenki.'},
                'include_hidden': {
                    'type': 'boolean',
                    'description': 'Include entries whose names start with a dot. Defaults to false.',
                },
            },
        },
        output_schema={
            'type': 'object',
            'properties': {
                'path': {'type': 'string', 'description': 'Absolute path of the listed directory.'},
                'entries': {
                    'type': 'array',
                    'items': {
                        'type': 'object',
                        'properties': {
                            'name': {'type': 'string'},
                            'is_dir': {'type': 'boolean'},
                            'size': {'type': 'integer', 'description': 'Size in bytes.'},
                        },
                    },
                },
                'truncated': {'type': 'boolean', 'description': 'True if the listing was cut at the output cap.'},
                'error': {'type': 'string', 'description': 'Error message if the directory could not be listed.'},
            },
        },
        description=lambda self: (
            "List a directory in the remote Tenki sandbox: each entry's name, whether it is a "
            f'directory, and its size, sorted by name. {_PATH_NOTE} {_SESSION_NOTE}'
        ),
    )
    def list_files(self, args):
        """List a directory in the shared Tenki session."""
        args = normalize_tool_input(args, tool_name='tenki')
        path = _normalize_path(args.get('path') or '.')
        include_hidden = optional_bool(args, 'include_hidden', default=False, tool_name='tenki')

        try:
            entries = self.IGlobal.call_with_session(
                lambda session: session.fs.list(path, include_hidden=include_hidden), replace=False
            )
        except (SandboxError, SessionEndedError) as e:
            return {'path': path, 'entries': [], 'truncated': False, 'error': _fs_error(e, path)}
        shaped, truncated = _listing(entries, self.IGlobal.max_output_chars)
        return {'path': path, 'entries': shaped, 'truncated': truncated}

    @tenki_tool(
        group='filesystem',
        input_schema={
            'type': 'object',
            'required': ['path'],
            'properties': {
                'path': {'type': 'string', 'description': 'Directory to create, e.g. "data/raw".'},
            },
        },
        output_schema=_CHANGE_OUTPUT_SCHEMA,
        description=lambda self: (
            'Create a directory in the remote Tenki sandbox, including any missing parent directories. '
            f'{_PATH_NOTE} {_SESSION_NOTE}'
        ),
    )
    def make_directory(self, args):
        """Create a directory in the shared Tenki session."""
        args = normalize_tool_input(args, tool_name='tenki')
        path = _normalize_path(args.get('path'))

        try:
            self.IGlobal.call_with_session(lambda session: session.fs.mkdir(path))
        except SandboxError as e:
            return {'success': False, 'path': path, 'error': _fs_error(e, path)}
        return {'success': True, 'path': path}

    @tenki_tool(
        group='filesystem',
        input_schema={
            'type': 'object',
            'required': ['path'],
            'properties': {
                'path': {'type': 'string', 'description': 'File or directory to delete, e.g. "build".'},
            },
        },
        output_schema=_CHANGE_OUTPUT_SCHEMA,
        description=lambda self: (
            'Delete a file or directory in the remote Tenki sandbox. A directory is deleted recursively, '
            'with everything inside it, and cannot be recovered. /home/tenki itself cannot be deleted. '
            f'{_PATH_NOTE} {_SESSION_NOTE}'
        ),
    )
    def delete_path(self, args):
        """Delete a file or directory, recursively, in the shared Tenki session."""
        args = normalize_tool_input(args, tool_name='tenki')
        path = _normalize_path(args.get('path'))
        if path == _HOME:
            # The agent's whole workspace: never a sensible target for one tool call.
            raise ValueError('refusing to delete /home/tenki itself; name a file or directory inside it')

        try:
            self.IGlobal.call_with_session(lambda session: session.fs.remove(path), replace=False)
        except (SandboxError, SessionEndedError) as e:
            return {'success': False, 'path': path, 'error': _fs_error(e, path)}
        return {'success': True, 'path': path}

    # -----------------------------------------------------------------------
    # Group: git
    #
    # Tenki's structured git helpers, which return git's raw output. Only git_clone may start a
    # fresh session: the others work on a repository that an ended session took with it.
    # -----------------------------------------------------------------------

    @tenki_tool(
        group='git',
        input_schema={
            'type': 'object',
            'required': ['repo'],
            'properties': {
                'repo': {
                    'type': 'string',
                    'description': 'Repository URL, e.g. "https://github.com/octocat/Hello-World.git".',
                },
                'directory': {
                    'type': 'string',
                    'description': (
                        'Folder to clone into, relative to /home/tenki or absolute under it. Defaults to '
                        'a folder named after the repository.'
                    ),
                },
                'branch': {'type': 'string', 'description': 'Branch to check out after cloning (optional).'},
                'depth': {
                    'type': 'integer',
                    'minimum': 1,
                    'description': 'Clone only this many of the most recent commits (optional).',
                },
            },
        },
        output_schema={
            'type': 'object',
            'properties': {
                'directory': {'type': 'string', 'description': 'Absolute path of the cloned repository.'},
                **_GIT_OUTPUT_SCHEMA['properties'],
            },
        },
        description=lambda self: (
            "Clone a git repository into the remote Tenki sandbox, returning git's output and the folder "
            'it was cloned into. Private GitHub repositories need a GitHub token configured on this node. '
            f'{_SESSION_NOTE}'
        ),
    )
    def git_clone(self, args):
        """Clone a git repository into the shared Tenki session."""
        args = normalize_tool_input(args, tool_name='tenki')
        repo = _git_arg(args, 'repo', required=True)
        branch = _git_arg(args, 'branch')
        depth = optional_int(args, 'depth', lo=1, tool_name='tenki')
        directory = _git_directory(args)
        if directory is None:
            # Chosen here rather than left to git, so the result can say where the repository went.
            folder = _clone_folder(repo)
            if folder is None:
                raise ValueError('could not derive a folder name from "repo"; pass "directory"')
            directory = _normalize_path(folder)

        try:
            output = self.IGlobal.call_with_session(
                lambda session: session.git.clone(repo, branch=branch, depth=depth, directory=directory)
            )
        except SandboxError as e:
            return {'directory': directory, 'output': '', 'truncated': False, 'error': str(e)}
        return {'directory': directory, **_git_result(output, self.IGlobal.max_output_chars)}

    @tenki_tool(
        group='git',
        input_schema={
            'type': 'object',
            'required': ['ref'],
            'properties': {
                'ref': {'type': 'string', 'description': 'Branch, tag or commit to check out.'},
                'create': {
                    'type': 'boolean',
                    'description': 'Create ref as a new branch (like git checkout -b). Defaults to false.',
                },
                'directory': _REPO_DIRECTORY,
            },
        },
        output_schema=_GIT_OUTPUT_SCHEMA,
        description=lambda self: (
            'Check out a branch, tag or commit in a git repository in the remote Tenki sandbox, or create '
            f'a new branch. {_SESSION_NOTE}'
        ),
    )
    def git_checkout(self, args):
        """Check out a ref in a repository in the shared Tenki session."""
        args = normalize_tool_input(args, tool_name='tenki')
        ref = _git_arg(args, 'ref', required=True)
        create = optional_bool(args, 'create', default=False, tool_name='tenki')
        directory = _git_directory(args)

        try:
            output = self.IGlobal.call_with_session(
                lambda session: session.git.checkout(ref, create=create, directory=directory), replace=False
            )
        except (SandboxError, SessionEndedError) as e:
            return {'output': '', 'truncated': False, 'error': str(e)}
        return _git_result(output, self.IGlobal.max_output_chars)

    @tenki_tool(
        group='git',
        input_schema={
            'type': 'object',
            'properties': {
                'range': {'type': 'string', 'description': 'Revision range to compare, e.g. "main..fix" (optional).'},
                'base': {'type': 'string', 'description': 'Revision to compare from, instead of a range (optional).'},
                'head': {'type': 'string', 'description': 'Revision to compare to, instead of a range (optional).'},
                'path': {
                    'type': 'string',
                    'description': 'Limit the diff to this file or folder, relative to the repository (optional).',
                },
                'directory': _REPO_DIRECTORY,
            },
        },
        output_schema=_GIT_OUTPUT_SCHEMA,
        description=lambda self: (
            'Show a git diff for a repository in the remote Tenki sandbox. Choose the revisions with a '
            f'range, or with base and head, and narrow it with path. {_SESSION_NOTE}'
        ),
    )
    def git_diff(self, args):
        """Show a diff for a repository in the shared Tenki session."""
        args = normalize_tool_input(args, tool_name='tenki')
        revisions = {key: _git_arg(args, key) for key in ('range', 'base', 'head')}
        if revisions['range'] and (revisions['base'] or revisions['head']):
            raise ValueError('pass either "range" or "base" and "head", not both')
        path = _git_arg(args, 'path')
        directory = _git_directory(args)

        try:
            output = self.IGlobal.call_with_session(
                lambda session: session.git.diff(**revisions, path=path, directory=directory), replace=False
            )
        except (SandboxError, SessionEndedError) as e:
            return {'output': '', 'truncated': False, 'error': str(e)}
        return _git_result(output, self.IGlobal.max_output_chars)

    @tenki_tool(
        group='git',
        input_schema={
            'type': 'object',
            'properties': {
                'max_count': {
                    'type': 'integer',
                    'minimum': 1,
                    'maximum': _MAX_LOG_COUNT,
                    'description': f'Number of commits to show. Defaults to {_DEFAULT_LOG_COUNT}.',
                },
                'range': {'type': 'string', 'description': 'Revision range to show, e.g. "main..fix" (optional).'},
                'path': {
                    'type': 'string',
                    'description': 'Only commits touching this file or folder, relative to the repository (optional).',
                },
                'directory': _REPO_DIRECTORY,
            },
        },
        output_schema=_GIT_OUTPUT_SCHEMA,
        description=lambda self: (
            'Show the commit log of a git repository in the remote Tenki sandbox, newest first, '
            f'{_DEFAULT_LOG_COUNT} commits unless max_count says otherwise. {_SESSION_NOTE}'
        ),
    )
    def git_log(self, args):
        """Show the commit log of a repository in the shared Tenki session."""
        args = normalize_tool_input(args, tool_name='tenki')
        max_count = optional_int(
            args, 'max_count', default=_DEFAULT_LOG_COUNT, lo=1, hi=_MAX_LOG_COUNT, tool_name='tenki'
        )
        revision_range = _git_arg(args, 'range')
        path = _git_arg(args, 'path')
        directory = _git_directory(args)

        try:
            output = self.IGlobal.call_with_session(
                lambda session: session.git.log(
                    max_count=max_count, range=revision_range, path=path, directory=directory
                ),
                replace=False,
            )
        except (SandboxError, SessionEndedError) as e:
            return {'output': '', 'truncated': False, 'error': str(e)}
        return _git_result(output, self.IGlobal.max_output_chars)
