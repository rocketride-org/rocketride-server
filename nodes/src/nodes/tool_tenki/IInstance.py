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

"""Tenki Sandbox tool node instance: the agent tools, all on the session IGlobal.call_with_session hands out."""

from __future__ import annotations

import dataclasses
import json
import posixpath
import re
import shlex
import threading
import time
import urllib.parse
import uuid
from typing import Callable

from rocketlib import IInstanceBase, tool_function, warning

from ai.common.utils import normalize_tool_input, optional_bool, optional_int, optional_str, require_str

from tenki import CommandTimeoutError, PermissionDeniedError, SandboxError
from tenki import FileNotFoundError as TenkiFileNotFoundError  # also subclasses the builtin it shadows

from .IGlobal import CommandNotStartedError, IGlobal, about_the_vm_link
from .sdk_shims import stop_keeping_output

_HOME = '/home/tenki'  # the home and working directory, and the only root Tenki's file API accepts

# Tenki-specific: unlike Daytona's, a Tenki session persists and is paused, not ended, at its lifetime.
_SESSION_NOTE = (
    'All Tenki Sandbox tools share one Linux VM, with /home/tenki as the home and working '
    'directory; files and installed packages persist between calls. A paused session is resumed '
    'on the next call: memory and files under /home/tenki survive, but /tmp is cleared and open '
    'network connections drop, so keep work under /home/tenki. Tenki pauses a session that reaches '
    'its maximum lifetime, and the next call resumes it the same way, which can take a minute. Only '
    'a session that has been terminated is replaced by a fresh, empty one.'
)
_PATH_NOTE = (
    'Paths are relative to /home/tenki or absolute under it; anything outside /home/tenki, including /tmp, is rejected.'
)

# git_log returns the whole log in one response, so it is always bounded.
_DEFAULT_LOG_COUNT = 20
_MAX_LOG_COUNT = 1000
# Tenki stops a command at its timeout and says so on the result; only a stalled stream outlasts this grace.
_RESULT_GRACE_SECS = 30
# The most output of one command the engine keeps: the SDK keeps all of it until the command exits, with no limit.
# Above the most the agent can be shown (1M characters, at most 4 MB of UTF-8).
_OUTPUT_LIMIT_BYTES = 8 * 1024 * 1024
# ReadFile returns the whole file in one message, so the size is checked with stat first, just under gRPC's 4 MiB.
_READ_LIMIT_BYTES = 4_000_000

# Process.kill() stops only the process the sandbox started, and every command shares one process group with the
# sandbox's agent: measured 2026-10-16, a killed pipeline's children streamed on until the execution timeout. So each
# command runs under `env TOOL_TENKI_RUN=<id>`, inherited by everything it starts, and this script stops, then kills,
# every process carrying it, found in /proc with bash builtins only, until none is left, then prints its counts. Out of
# reach: a process that clears its environment or runs as another user; Tenki's execution timeout stops those.
_RUN_MARKER = 'TOOL_TENKI_RUN'
_KILL_TREE_SCRIPT = (
    'm="$1"; found=" "; killed=" "; '
    'scan() { hit=""; for d in /proc/[0-9]*; do p="${d##*/}"; [ "$p" = "$$" ] && continue; '
    '{ while IFS= read -r -d "" kv; do if [ "$kv" = "$m" ]; then hit="$hit $p"; '
    '[ "$1" = stop ] && kill -STOP "$p" 2>/dev/null; break; fi; done < "$d/environ"; } 2>/dev/null; done; }; '
    'for pass in 1 2 3 4 5 6; do scan stop; [ -z "$hit" ] && break; for p in $hit; do '
    'case "$found" in *" $p "*) ;; *) found="$found$p ";; esac; '
    'kill -KILL "$p" 2>/dev/null && case "$killed" in *" $p "*) ;; *) killed="$killed$p ";; esac; done; done; '
    'scan; for wait in 1 2 3 4 5 6 7 8 9 10; do [ -z "$hit" ] && break; sleep 0.1 2>/dev/null; scan; done; '
    'k=0; for p in $killed; do case "$hit " in *" $p "*) ;; *) k=$((k+1));; esac; done; '
    'set -- $found; f=$#; set -- $hit; echo "found=$f killed=$k left=$#"; [ $# -eq 0 ]'
)
_KILL_TREE_WAIT_SECS = 15
# A run that outlives the kill by more than this was kept going by a process out of its reach (one under sudo, say).
_KILL_SETTLE_SECS = 10
_KILLED_NOTICE = (
    '[tool_tenki: the command was killed before it finished, because it produced more than {limit:,} bytes '
    'of output, the most a command may stream back, and output past that point was not kept. Send large '
    'output to a file instead (for example `> out.log 2>&1`) and read back the part you need.]'
)
_CUT_NOTICE = (
    '[tool_tenki: the command produced more than {limit:,} bytes of output, the most a command may stream '
    'back, and output past that point was not kept. The node could not confirm that it stopped the command: '
    'it had finished by then, or part of it was out of reach (run under sudo, for example) and ran until it '
    'ended or reached the execution timeout. Send large output to a file instead (for example '
    '`> out.log 2>&1`) and read back the part you need.]'
)

# Tenki's documented answer (HTTP 403) when its proxy refuses to put a secret into a request; measured 2026-10-10.
_INJECTION_DENIED = 'secret_injection_denied'
_DENIED_NOTICE = (
    '[tool_tenki: this output contains "secret_injection_denied". Tenki documents that as its answer '
    '(HTTP 403) when it refuses to put a secret into a request, for example because no attached secret '
    'policy allows that secret for that host, method and path. If that is what happened here, repeating '
    'the request will not help: the policy is for the operator of this pipeline to change.]'
)

_SESSION_EVENT = {
    'type': 'string',
    'enum': ['created', 'resumed', 'replaced', 'ended'],
    'description': (
        'Present only when the sandbox session changed during this call. "created": this call started a new, '
        'empty sandbox (the first call, or the first after one ended). "resumed": it had been paused, and memory '
        'and /home/tenki survived but /tmp was cleared. "replaced": it had ended, so earlier files and installed '
        'packages are gone and this call ran on a new, empty sandbox. "ended": it had ended and this call did not '
        'continue: earlier files are gone, and the next call starts a new, empty sandbox.'
    ),
}

# The interpreter and file extension per language. No TypeScript: ts-node is not in Tenki's base image, and a .ts run
# through it exited 0 with no output.
_LANGUAGES = {'python': ('python3', '.py'), 'javascript': ('node', '.js')}

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
        'truncated': {
            'type': 'boolean',
            'description': 'True if stdout or stderr was cut to fit the output cap, or the command produced more '
            'output than is kept (stderr then says so, and whether the command was killed for it).',
        },
        'error': {'type': 'string', 'description': 'Error message if the sandbox call failed.'},
        'session': _SESSION_EVENT,
    },
}
_CHANGE_OUTPUT_SCHEMA = {
    'type': 'object',
    'properties': {
        'success': {'type': 'boolean'},
        'path': {'type': 'string', 'description': 'Absolute path in the sandbox.'},
        'error': {'type': 'string', 'description': 'Error message if the operation failed.'},
        'session': _SESSION_EVENT,
    },
}
_GIT_OUTPUT_SCHEMA = {
    'type': 'object',
    'properties': {
        'output': {'type': 'string', 'description': "git's output."},
        'truncated': {'type': 'boolean', 'description': 'True if the output was cut at the output cap.'},
        'error': {'type': 'string', 'description': 'Error message if the git operation failed.'},
        'session': _SESSION_EVENT,
    },
}
_REPO_DIRECTORY = {
    'type': 'string',
    'description': (
        "The repository's folder (the equivalent of git -C), relative to /home/tenki or absolute "
        'under it. Defaults to /home/tenki.'
    ),
}


def _tool(group: str, **meta) -> Callable:
    """``@tool_function`` plus the tool group the tool is published under (see IInstance._collect_tool_methods)."""

    def decorator(fn: Callable) -> Callable:
        fn = tool_function(**meta)(fn)
        fn.__tenki_group__ = group
        return fn

    return decorator


def _explained(text: str) -> str:
    """``text``, followed by what a denied secret injection means when it reports one."""
    return f'{text}\n{_DENIED_NOTICE}' if _INJECTION_DENIED in text else text


def _truncate(text: str, cap: int) -> tuple[str, bool]:
    """Cap tool output so a chatty script cannot flood the agent context."""
    # The same as tool_daytona's, which this node cannot import without depending on the daytona SDK.
    if text is None:
        return '', False
    text = str(text)
    if len(text) <= cap:
        return text, False
    return text[:cap], True


def _normalize_path(path) -> str:
    """An agent's path resolved under /home/tenki (a usability check: run_command reaches the whole VM anyway)."""
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
    if isinstance(error, TenkiFileNotFoundError) and not about_the_vm_link(error):
        return f'no such file or directory: {path}'
    if isinstance(error, PermissionDeniedError):
        return f'{error} (file operations are limited to paths under /home/tenki)'
    return str(error)


def _occurrences(text: str, old: str) -> int:
    """How many times ``old`` occurs in ``text``, overlapping matches included ("aa" occurs twice in "aaa")."""
    found, start = 0, text.find(old)
    while start != -1:
        found += 1
        start = text.find(old, start + 1)
    return found


def _listing(entries, cap: int) -> tuple[list[dict], bool]:
    """Directory entries by name, stopping before the listing's JSON would pass ``cap``."""
    shaped, used = [], 2  # the enclosing brackets
    for entry in sorted(entries, key=lambda info: info.path):  # in a listing, a FileInfo's path is the entry's name
        item = {'name': entry.path, 'is_dir': bool(entry.is_dir), 'size': int(entry.size)}
        used += len(json.dumps(item)) + 2  # the entry and its separator
        if used > cap:
            return shaped, True
        shaped.append(item)
    return shaped, False


def _git_arg(args: dict, key: str, *, required: bool = False) -> str | None:
    """A stripped git argument, or None when optional and absent; one git would read as an option is refused."""
    if required:
        value = require_str(args, key, tool_name='tenki')
    else:
        value = (optional_str(args, key, tool_name='tenki') or '').strip() or None
    if value is not None and value.startswith('-'):
        raise ValueError(f'"{key}" must not start with "-", which git would read as an option')
    return value


def _git_directory(args: dict) -> str | None:
    """The repository folder resolved under /home/tenki, or None if not given."""
    directory = (optional_str(args, 'directory', tool_name='tenki') or '').strip()
    return _normalize_path(directory) if directory else None


def _clone_url(repo: str) -> str:
    """``repo`` if it is an http(s) URL with no credentials, query or fragment, which git would store in .git/config."""
    parsed = urllib.parse.urlsplit(repo)
    if parsed.scheme.lower() not in ('http', 'https'):
        raise ValueError(
            f'"repo" must be an http(s) URL, such as https://github.com/owner/repo.git, but {repo!r} is not. '
            'ssh, git, file and local repositories cannot be cloned: this node has no way to authenticate to them.'
        )
    if parsed.username or parsed.password or '@' in parsed.netloc:
        raise ValueError(
            '"repo" must not carry credentials in the URL: they would be written into the '
            'sandbox, which this node never places a secret in.'
        )
    if parsed.query or parsed.fragment:
        raise ValueError(
            '"repo" must not carry a query string or fragment: a token there would be written into the '
            'sandbox, which this node never places a secret in.'
        )
    if not parsed.hostname:
        raise ValueError(f'"repo" must be an http(s) URL with a host, but {repo!r} has none')
    return repo


def _under_prefix(repo: str, prefix: str) -> bool:
    """Whether git applies an ``http.<prefix>.*`` setting to ``repo``: same scheme, host and port, path under it."""
    url = urllib.parse.urlsplit(repo)
    try:
        port = url.port
    except ValueError:
        return False
    want = urllib.parse.urlsplit(prefix)
    path = url.path if url.path.endswith('/') else url.path + '/'
    return (
        url.scheme.lower() == 'https'
        and port in (None, 443)
        and url.hostname == want.hostname
        and path.startswith(want.path)
    )


def _private_clone_argv(
    repo: str, directory: str, branch: str | None, depth: int | None, prefix: str, secret: str
) -> tuple[str, ...]:
    """The clone command for a private repository, with Tenki's placeholder as its only credential."""
    # Measured 2026-10-10: the header goes on the clone and stays in the clone's config, scoped to the prefix, so a
    # later fetch authenticates too. No shell, and no terminal prompt, so a refused request fails instead of waiting.
    argv = ['env', 'GIT_TERMINAL_PROMPT=0', 'git', 'clone']
    argv += ['--config', f'http.{prefix}.extraHeader=Authorization: Basic secrets://{secret}']
    if branch:
        argv += ['--branch', branch]
    if depth:
        argv += ['--depth', str(depth)]
    return (*argv, '--', repo, directory)


def _private_clone_note(glb) -> str:
    """What git_clone's description says about private repositories, as the pipeline is configured."""
    if not glb.git_auth_secret:
        return 'Private repositories cannot be cloned: this node holds no git credentials.'
    return (
        f'Private repositories under {glb.git_auth_url} can be cloned with an https URL: Tenki adds the '
        'credential outside the sandbox, and a later fetch or pull in the clone, run_command included, '
        'authenticates the same way. Other private repositories cannot be cloned.'
    )


def _clone_folder(repo: str) -> str | None:
    """The folder git itself clones ``repo`` into: its last path segment, without ``.git``."""
    name = repo.rstrip('/').rsplit('/', 1)[-1]
    if name.endswith('.git'):
        name = name[: -len('.git')]
    return None if name in ('', '.', '..') else name


def _git_result(output, cap: int) -> dict:
    text, truncated = _truncate(output, cap)
    return {'output': text, 'truncated': truncated}


def _git_error(error: Exception) -> dict:
    return {'output': '', 'truncated': False, 'error': _explained(str(error))}


def _exec_result(outcome, cap: int) -> dict:
    """A command's (result, cut, killed) as the tool output, ``cap`` shared by both streams."""
    result, cut, killed = outcome
    # stderr, where errors land, keeps at least half the cap however much stdout printed.
    stdout_text, stderr_text = result.stdout_text, result.stderr_text
    stderr, stderr_cut = _truncate(stderr_text, max(cap // 2, cap - len(stdout_text)))
    stdout, stdout_cut = _truncate(stdout_text, cap - len(stderr))
    # Notices after the cap, so it never cuts them off. "Killed" by the kill's own count, never the exit status.
    if cut:
        notice = (_KILLED_NOTICE if killed else _CUT_NOTICE).format(limit=_OUTPUT_LIMIT_BYTES)
        stderr = f'{stderr}\n{notice}' if stderr else notice
    if _INJECTION_DENIED in stdout_text or _INJECTION_DENIED in stderr_text:
        stderr = f'{stderr}\n{_DENIED_NOTICE}' if stderr else _DENIED_NOTICE
    return {
        'exit_code': result.exit_code,
        'stdout': stdout,
        'stderr': stderr,
        'timed_out': bool(result.timed_out),
        'truncated': cut or stdout_cut or stderr_cut,
    }


def _exec_error(error: SandboxError) -> dict:
    return {
        'error': _explained(str(error)),
        'exit_code': -1,
        'stdout': '',
        'stderr': '',
        # The call ran past a deadline; a command stopped at its own timeout comes back as a result instead.
        'timed_out': isinstance(error, CommandTimeoutError),
        'truncated': False,
    }


def _kill_command_tree(session, process, marker: str) -> tuple[int, int] | None:
    """Kill every process carrying ``marker``, then send the sandbox's kill; (found, killed), or None if it failed."""
    report, killer = None, None
    try:
        killer = session.start('bash', '-c', _KILL_TREE_SCRIPT, 'tool_tenki-kill', marker, timeout=_KILL_TREE_WAIT_SECS)
        killer.close_stdin()
        outcome = killer.wait(timeout=_KILL_TREE_WAIT_SECS + _RESULT_GRACE_SECS)
        # The last line: a custom image's BASH_ENV may print before the script does.
        last = outcome.stdout_text.strip().rpartition('\n')[2]
        counts = re.fullmatch(r'found=(\d+) killed=(\d+) left=(\d+)', last)
        if counts is None or outcome.exit_code != 0 or outcome.signal or outcome.timed_out:
            stopped = ', stopped at its timeout' if outcome.timed_out else ''
            raise SandboxError(
                f'the kill command reported {last or "nothing"!r} and exited {outcome.exit_code}{stopped}'
            )
        report = int(counts[1]), int(counts[2])
    except Exception as e:
        warning(
            'tool_tenki: could not stop all the processes of a command that passed the output limit '
            f'({e}); what is left runs on in the VM until the execution timeout. None of its output past '
            'the limit is kept.'
        )
    finally:
        if killer is not None:
            stop_keeping_output(killer)
    process.kill()
    return report


def _stopped_by_kill(report: tuple[int, int] | None, ran_on: float) -> int:
    """How many processes the agent is told the kill stopped: 0 unless it ran and the run ended right after it."""
    if report is None:
        return 0
    found, killed = report
    if ran_on > _KILL_SETTLE_SECS:
        what = f'stopped {killed} of the {found} processes it found' if found else 'found none of its processes'
        warning(
            f'tool_tenki: a command passed the output limit, and the kill {what}, but the run went on for '
            f"{ran_on:.0f} s after it: part of the command was out of the kill's reach (run under sudo, or with a "
            'cleared environment) and ran until it ended or reached the execution timeout. None of its output past '
            'the limit is kept.'
        )
        return 0
    if not found:
        warning(
            'tool_tenki: a command passed the output limit, and the kill found none of its processes: the run ended '
            'right after, so the command had finished by then. None of its output past the limit is kept.'
        )
    return killed


def _run_ended(process) -> bool:
    """Whether ``process``'s result is in or its run failed (the SDK sets ``_done`` before it ends the streams)."""
    done = getattr(process, '_done', None)
    return done is not None and done.is_set()


class _OutputGuard:
    """Reads a command's output as it arrives; past ``limit`` bytes the SDK keeps no more and the command is killed."""

    def __init__(self, process, limit: int, session, marker: str):
        self._process = process
        self._session = session
        self._marker = marker
        self._limit = limit
        self._lock = threading.Lock()
        self._received = 0
        self._kept = ([], [])
        self.cut = False
        self.kill = None  # what _kill_command_tree reported, and when it returned
        self.kill_done = 0.0
        self._readers = [
            threading.Thread(target=self._read, args=(stream, kept), name='tool_tenki-output', daemon=True)
            for stream, kept in zip((process.stdout, process.stderr), self._kept)
        ]
        for reader in self._readers:
            reader.start()

    def kept(self) -> tuple[bytes, bytes]:
        """The stdout and stderr kept: all of both, or once ``cut``, the first ``limit`` bytes."""
        return b''.join(self._kept[0]), b''.join(self._kept[1])

    def _read(self, stream, kept: list) -> None:
        try:
            for chunk in stream:
                with self._lock:
                    if self.cut:
                        continue  # arrived before the streams were swapped: not kept
                    kept.append(chunk[: self._limit - self._received])
                    self._received += len(chunk)
                    cut = self.cut = self._received > self._limit
                if cut:
                    stop_keeping_output(self._process)
                    # A run whose exit already arrived sends nothing more, and what it left running on purpose stays.
                    if not _run_ended(self._process):
                        self.kill = _kill_command_tree(self._session, self._process, self._marker)
                    self.kill_done = time.monotonic()
        except Exception:
            pass  # a stream fails when its run does, and wait() raises that same error

    def stop(self) -> None:
        """Stop keeping the output and wait for the readers; swapping the streams is what ends theirs after a stall."""
        stop_keeping_output(self._process)
        for reader in self._readers:
            reader.join()


class ResultTimeoutError(CommandTimeoutError):
    """No result arrived for a command within the node's own limit (see _run_process)."""


class CommandInterruptedError(SandboxError):
    """A started command lost its session and was not started again; ``cause`` is the recovery or the failure."""

    def __init__(self, cause) -> None:
        if cause == 'resumed':
            # Measured on sessions paused at max_duration: the command's process was gone within 2 s of the resume.
            message = (
                'the sandbox was paused while this command was running, and has been resumed. The command was '
                'cut off part-way and was not run again, so part of its work may be done. Check what it did '
                'before running it again.'
            )
        elif cause == 'replaced':
            message = (
                'the sandbox session ended while this command was running, so its files are gone, along with '
                'whatever the command had done inside the sandbox. The command was not run again: the next '
                'command or file write starts a fresh, empty sandbox. Anything the command did outside the '
                'sandbox is still done, so check that before running it again.'
            )
        else:
            message = (
                f'the call lost the sandbox while this command was running ({cause}). The command was not run '
                'again: it may still be running, or it may have been cut off part-way, so part of its work may '
                'be done. Check what it did before running it again.'
            )
        super().__init__(message)


class ChangeInterruptedError(SandboxError):
    """A sent change lost its session and was not sent again; ``cause`` is the recovery or the failure."""

    def __init__(self, what: str, cause) -> None:
        how = (
            'found the sandbox paused, and the sandbox has been resumed' if cause == 'resumed' else f'failed ({cause})'
        )
        super().__init__(
            f'this {what} {how}. The {what} was not sent again, so it may or may not have taken effect. '
            'Check before retrying.'
        )


class _Once:
    """Lets call_with_session retry a call after a recovery only until its command started or its change was sent."""

    def __init__(self, stop_on: frozenset, error: Callable[[object], SandboxError]) -> None:
        self.stop_on = stop_on  # the recoveries that end the call once ``done``
        self.error = error  # the agent's error, from the recovery ('resumed', 'replaced') or the failure
        self.done = False


def _change_once(what: str) -> _Once:
    # A change acts only inside the sandbox, so on a replaced, empty session it is sent again.
    return _Once(frozenset({'resumed'}), lambda cause: ChangeInterruptedError(what, cause))


def _run_process(session, argv, timeout: int, once: _Once):
    """Run ``argv`` with bounded waits and output; (result, cut, killed), with ``once.done`` set once it started."""
    limit = timeout + _RESULT_GRACE_SECS
    marker = f'{_RUN_MARKER}={uuid.uuid4().hex}'
    process = session.start('env', marker, *argv, timeout=timeout)
    try:
        process.close_stdin()
    except SandboxError:
        stop_keeping_output(process)
        # close_stdin re-raises a run error that arrived after the started frame: the command did start.
        once.done = process.pid is not None
        raise
    except TimeoutError as e:
        # The SDK gives up on the start after 30 s without cancelling it, and a late start still runs the command.
        stop_keeping_output(process)
        process.kill()
        raise CommandNotStartedError('the sandbox did not start the command in time, so it was cancelled') from e
    once.done = True
    guard = _OutputGuard(process, _OUTPUT_LIMIT_BYTES, session, marker)
    try:
        result = process.wait(timeout=limit)
        ended = time.monotonic()
    except SandboxError:
        raise
    except TimeoutError as e:
        raise ResultTimeoutError(
            f'the sandbox reported no result within {limit}s, {_RESULT_GRACE_SECS}s past the execution timeout '
            'at which Tenki stops a command. A kill was sent as well, but over a stalled connection it may '
            'not have arrived.'
        ) from e
    finally:
        guard.stop()
    if not guard.cut:
        return result, False, 0
    stdout, stderr = guard.kept()  # the SDK kept nothing once its streams were swapped
    result = dataclasses.replace(result, stdout=stdout, stderr=stderr)
    return result, True, _stopped_by_kill(guard.kill, ended - guard.kill_done)


class IInstance(IInstanceBase):
    IGlobal: IGlobal

    def _collect_tool_methods(self) -> dict[str, Callable]:
        """Publish only the tools of the enabled groups; a tool without a group is never published."""
        enabled = self.IGlobal.tool_groups
        return {
            name: method
            for name, method in super()._collect_tool_methods().items()
            if getattr(getattr(type(self), name, None), '__tenki_group__', None) in enabled
        }

    def _call(self, fn, shape, failed, **kwargs) -> dict:
        """``shape(fn(session))``, or ``failed(error)`` for a SandboxError, plus the session change if any."""
        events = []
        try:
            value = self.IGlobal.call_with_session(fn, events, **kwargs)
        except SandboxError as e:
            output = failed(e)
        else:
            output = shape(value)
        if events:
            output['session'] = events[-1]
        return output

    def _run(self, run) -> dict:
        # A command may have acted outside the sandbox (a deploy, a request), so once started it never runs again, and
        # however its call then fails, the agent is told part of its work may be done.
        once = _Once(frozenset({'resumed', 'replaced'}), CommandInterruptedError)
        cap = self.IGlobal.max_output_chars

        def failed(error) -> dict:
            if once.done and not isinstance(error, (CommandInterruptedError, ResultTimeoutError)):
                error = CommandInterruptedError(error)
            return _exec_error(error)

        return self._call(lambda session: run(session, once), lambda out: _exec_result(out, cap), failed, once=once)

    def _change(self, path: str, what: str, change, *, replace: bool = True) -> dict:
        """A file change whose ``change`` returns None, or the reason it refused, as the tool output."""
        once = _change_once(what)
        return self._call(
            lambda session: change(session, once),
            lambda refused: {'success': not refused, 'path': path, **({'error': refused} if refused else {})},
            lambda e: {'success': False, 'path': path, 'error': _fs_error(e, path)},
            replace=replace,
            once=once,
        )

    # Group: execution. Both tools run through a bash login shell, which puts nvm's node on PATH, as Tenki's own
    # shell helper does.

    @_tool(
        'execution',
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
                    'description': (
                        'Directory to run in (optional); must be under /home/tenki, where a relative path '
                        'resolves. If it is not a folder the command can enter, the command does not run: '
                        'exit_code is 1 and stderr says why.'
                    ),
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
        command = require_str(args, 'command', tool_name='tenki')
        cwd = (optional_str(args, 'cwd', tool_name='tenki') or '').strip()
        if cwd:
            # In the script, not exec's cwd: a cd in the login shell's startup files would win over that.
            # On its own line, so a failed cd ends the script instead of skipping only the first command.
            command = f'cd {shlex.quote(_normalize_path(cwd))} || exit 1\n{command}'
        timeout = self.IGlobal.exec_timeout_secs
        return self._run(lambda session, once: _run_process(session, ('bash', '-lc', command), timeout, once))

    @_tool(
        'execution',
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
                    'description': 'Language of the code: python (python3) or javascript (node). Defaults to python.',
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
        require_str(args, 'code', tool_name='tenki')
        code = args['code']  # as given: stripping would shift the line numbers of a traceback
        language = optional_str(args, 'language', tool_name='tenki') or 'python'
        if language not in _LANGUAGES:
            raise ValueError(f'"language" must be one of: {", ".join(sorted(_LANGUAGES))}')
        interpreter, extension = _LANGUAGES[language]
        path = f'{_HOME}/.tenki-run-{uuid.uuid4().hex}{extension}'  # a fresh name per call: calls share the session
        timeout = self.IGlobal.exec_timeout_secs

        def run(session, once):
            # Through the file API rather than a heredoc, whose escaping would mangle multi-line code.
            session.fs.write_text(path, code)
            try:
                return _run_process(session, ('bash', '-lc', 'exec "$@"', 'bash', interpreter, path), timeout, once)
            finally:
                try:
                    session.fs.remove(path)
                except Exception:
                    pass  # a leftover file is harmless; failing here would hide the run's own result

        return self._run(run)

    # Group: filesystem. Every path goes through _normalize_path first. Reads, listings, edits and deletes pass
    # replace=False: a fresh, empty session could not contain what they look for.

    @_tool(
        'filesystem',
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
            f'along with any missing parent directories. Content over {_READ_LIMIT_BYTES:,} bytes is refused. '
            f'{_PATH_NOTE} {_SESSION_NOTE}'
        ),
    )
    def write_file(self, args):
        """Write a text file in the shared Tenki session."""
        args = normalize_tool_input(args, tool_name='tenki')
        path = _normalize_path(args.get('path'))
        content = args.get('content')
        if not isinstance(content, str):
            raise ValueError('"content" is required and must be a string')
        size = len(content.encode('utf-8'))
        if size > _READ_LIMIT_BYTES:
            raise ValueError(
                f'"content" is {size:,} bytes, more than the {_READ_LIMIT_BYTES:,} write_file sends; '
                'create a file that large with run_command instead'
            )

        def write(session, once):
            with self.IGlobal.path_lock(path):
                once.done = True
                try:
                    session.fs.write_text(path, content)
                except TenkiFileNotFoundError as e:
                    if about_the_vm_link(e):
                        raise
                    session.fs.mkdir(posixpath.dirname(path))  # the parent is missing: create it and its parents
                    session.fs.write_text(path, content)

        return self._change(path, 'file write', write)

    @_tool(
        'filesystem',
        input_schema={
            'type': 'object',
            'required': ['path', 'old_text', 'new_text'],
            'properties': {
                'path': {'type': 'string', 'description': 'File to edit, e.g. "app/main.py".'},
                'old_text': {
                    'type': 'string',
                    'description': (
                        'The exact text to replace, as it appears in the file, whitespace and line endings included. '
                        'It must occur exactly once: include enough surrounding lines to make it unique.'
                    ),
                },
                'new_text': {'type': 'string', 'description': 'The text to put in its place (may be empty).'},
            },
        },
        output_schema=_CHANGE_OUTPUT_SCHEMA,
        description=lambda self: (
            'Edit a text file in the remote Tenki sandbox by replacing one exact, unique occurrence of old_text '
            'with new_text. Refused, and nothing written, when old_text occurs zero times or more than once. '
            f'Use it for a small change instead of rewriting the whole file with write_file. {_PATH_NOTE} '
            f'{_SESSION_NOTE}'
        ),
    )
    def edit_file(self, args):
        """Replace one exact, unique occurrence of old_text in a text file in the shared Tenki session."""
        args = normalize_tool_input(args, tool_name='tenki')
        path = _normalize_path(args.get('path'))
        old, new = args.get('old_text'), args.get('new_text')
        if not isinstance(old, str) or not old:
            raise ValueError('"old_text" is required and must be a non-empty string')
        if not isinstance(new, str):
            raise ValueError('"new_text" is required and must be a string (it may be empty)')

        def edit(session, once):
            # The read-modify-write is not atomic: another change of this path through the node waits for it.
            with self.IGlobal.path_lock(path):
                info = session.fs.stat(path)
                if info.is_dir:
                    return f'{path} is a directory; edit_file changes one text file'
                if info.size > _READ_LIMIT_BYTES:
                    return (
                        f'{path} is {info.size:,} bytes, more than the {_READ_LIMIT_BYTES:,} edit_file reads; '
                        'change it with run_command (sed -i, for example)'
                    )
                try:
                    text = session.fs.read_bytes(path).decode('utf-8')
                except UnicodeDecodeError:
                    return f'{path} is not UTF-8 text, so edit_file cannot change it'
                found = _occurrences(text, old)
                if found != 1:
                    return f'old_text was found {found} times in {path}; it must occur exactly once. ' + (
                        'Check it against the file with read_file.' if found == 0 else 'Include more surrounding lines.'
                    )
                edited = text.replace(old, new, 1)
                if len(edited.encode('utf-8')) > _READ_LIMIT_BYTES:
                    return (
                        f'the edited file would be more than {_READ_LIMIT_BYTES:,} bytes, which read_file could not '
                        'read back; change it with run_command instead'
                    )
                once.done = True  # the read is not a change: a pause before this point is retried
                session.fs.write_text(path, edited)

        return self._change(path, 'edit', edit, replace=False)

    @_tool(
        'filesystem',
        input_schema={
            'type': 'object',
            'required': ['path'],
            'properties': {'path': {'type': 'string', 'description': 'File to read, e.g. "app/main.py".'}},
        },
        output_schema={
            'type': 'object',
            'properties': {
                'path': {'type': 'string', 'description': 'Absolute path in the sandbox.'},
                'content': {'type': 'string', 'description': 'File content decoded as UTF-8.'},
                'truncated': {'type': 'boolean', 'description': 'True if the content was cut at the output cap.'},
                'error': {'type': 'string', 'description': 'Error message if the file could not be read.'},
                'session': _SESSION_EVENT,
            },
        },
        description=lambda self: (
            'Read a text file from the remote Tenki sandbox, decoded as UTF-8. At most '
            f'{self.IGlobal.max_output_chars} characters are returned, and a file over '
            f'{_READ_LIMIT_BYTES:,} bytes is refused. {_PATH_NOTE} {_SESSION_NOTE}'
        ),
    )
    def read_file(self, args):
        """Read a text file from the shared Tenki session."""
        args = normalize_tool_input(args, tool_name='tenki')
        path = _normalize_path(args.get('path'))
        cap = self.IGlobal.max_output_chars

        def read(session):
            info = session.fs.stat(path)
            return info, (None if info.is_dir or info.size > _READ_LIMIT_BYTES else session.fs.read_bytes(path))

        def failed(error) -> dict:
            return {'path': path, 'content': '', 'truncated': False, 'error': error}

        def shape(outcome) -> dict:
            info, data = outcome
            if info.is_dir:
                return failed(f'{path} is a directory; use list_files to see what is in it')
            if data is None:
                return failed(
                    f'{path} is {info.size:,} bytes, more than the {_READ_LIMIT_BYTES:,} read_file fetches; '
                    'read the part you need with run_command (head, tail or sed -n)'
                )
            content, truncated = _truncate(data.decode('utf-8', errors='replace'), cap)
            return {'path': path, 'content': content, 'truncated': truncated}

        return self._call(read, shape, lambda e: failed(_fs_error(e, path)), replace=False)

    @_tool(
        'filesystem',
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
                'session': _SESSION_EVENT,
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
        cap = self.IGlobal.max_output_chars

        def shape(entries) -> dict:
            shaped, truncated = _listing(entries, cap)
            return {'path': path, 'entries': shaped, 'truncated': truncated}

        return self._call(
            lambda session: session.fs.list(path, include_hidden=include_hidden),
            shape,
            lambda e: {'path': path, 'entries': [], 'truncated': False, 'error': _fs_error(e, path)},
            replace=False,
        )

    @_tool(
        'filesystem',
        input_schema={
            'type': 'object',
            'required': ['path'],
            'properties': {'path': {'type': 'string', 'description': 'Directory to create, e.g. "data/raw".'}},
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

        def mkdir(session, once):
            once.done = True
            session.fs.mkdir(path)

        return self._change(path, 'directory creation', mkdir)

    @_tool(
        'filesystem',
        input_schema={
            'type': 'object',
            'required': ['path'],
            'properties': {'path': {'type': 'string', 'description': 'File or directory to delete, e.g. "build".'}},
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
            raise ValueError('refusing to delete /home/tenki itself; name a file or directory inside it')

        def remove(session, once):
            with self.IGlobal.path_lock(path):  # an edit of this file in flight would otherwise write it back
                once.done = True
                session.fs.remove(path)

        return self._change(path, 'delete', remove, replace=False)

    # Group: git. Tenki's git helpers, which return git's raw output. Only git_clone may start a fresh session: the
    # others work on a repository that an ended session took with it.

    @_tool(
        'git',
        input_schema={
            'type': 'object',
            'required': ['repo'],
            'properties': {
                'repo': {
                    'type': 'string',
                    'description': (
                        'Repository URL, e.g. "https://github.com/octocat/Hello-World.git": http(s) only, with no '
                        'credentials, query string or fragment in it.'
                    ),
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
            f'it was cloned into. {_private_clone_note(self.IGlobal)} '
            f'The clone must finish within {self.IGlobal.rpc_timeout_secs}s, so use depth for large '
            f'repositories. {_SESSION_NOTE}'
        ),
    )
    def git_clone(self, args):
        """Clone a git repository into the shared Tenki session."""
        args = normalize_tool_input(args, tool_name='tenki')
        repo = _clone_url(_git_arg(args, 'repo', required=True))
        branch = _git_arg(args, 'branch')
        depth = optional_int(args, 'depth', lo=1, tool_name='tenki')
        directory = _git_directory(args)
        if directory is None:
            folder = _clone_folder(repo)  # chosen here, not by git, so the result can say where the clone went
            if folder is None:
                raise ValueError('could not derive a folder name from "repo"; pass "directory"')
            directory = _normalize_path(folder)
        glb = self.IGlobal
        cap = glb.max_output_chars
        # Only clones under the private prefix carry the placeholder: Tenki refuses a request carrying one that no
        # attached policy allows (measured: 403 secret_injection_denied on a public repository).
        private = None
        if glb.git_auth_secret and _under_prefix(repo, glb.git_auth_url):
            private = _private_clone_argv(repo, directory, branch, depth, glb.git_auth_url, glb.git_auth_secret)
        once = _change_once('clone')

        def clone(session):
            if private is None:
                once.done = True
                return session.git.clone(repo, branch=branch, depth=depth, directory=directory)
            return _run_process(session, private, glb.rpc_timeout_secs, once)  # sent once git started, as a command

        def failed(error) -> dict:
            text, cut = _truncate(str(error), cap)
            return {'directory': directory, 'output': '', 'truncated': cut, 'error': _explained(text)}

        def shape(output) -> dict:
            if private is not None:
                result, cut, killed = output
                output = '\n'.join(part for part in (result.stderr_text.strip(), result.stdout_text.strip()) if part)
                # Each note goes first, so that truncating git's output cannot cut it off.
                if killed:
                    return failed(f'{_KILLED_NOTICE.format(limit=_OUTPUT_LIMIT_BYTES)} git printed: {output}')
                if cut:
                    output = f'{_CUT_NOTICE.format(limit=_OUTPUT_LIMIT_BYTES)} git printed: {output}'
                if result.timed_out:
                    return failed(
                        f'the clone did not finish within {glb.rpc_timeout_secs}s, when Tenki stopped it; use '
                        f'depth for a large repository. git printed: {output}'
                    )
                if result.exit_code != 0:
                    return failed(f'git clone failed (exit code {result.exit_code}): {output}')
            return {'directory': directory, **_git_result(output, cap)}

        return self._call(clone, shape, failed, once=once)

    @_tool(
        'git',
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
        cap = self.IGlobal.max_output_chars
        once = _change_once('checkout')

        def checkout(session):
            once.done = True
            return session.git.checkout(ref, create=create, directory=directory)

        return self._call(checkout, lambda out: _git_result(out, cap), _git_error, replace=False, once=once)

    @_tool(
        'git',
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
        cap = self.IGlobal.max_output_chars
        return self._call(
            lambda session: session.git.diff(**revisions, path=path, directory=directory),
            lambda out: _git_result(out, cap),
            _git_error,
            replace=False,
        )

    @_tool(
        'git',
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
        cap = self.IGlobal.max_output_chars
        return self._call(
            lambda session: session.git.log(max_count=max_count, range=revision_range, path=path, directory=directory),
            lambda out: _git_result(out, cap),
            _git_error,
            replace=False,
        )
