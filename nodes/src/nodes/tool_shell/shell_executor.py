# =============================================================================
# MIT License
# Copyright (c) 2024 RocketRide Inc.
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
Subprocess driver for tool_shell.

Runs a command in the host with bounded timeout and output capture. The
default is argv-list execution with no shell (eliminates the shell-injection
attack class); shell mode is opt-in via ``use_shell=True``.
"""

from __future__ import annotations

import os
import re
import signal
import subprocess
import sys
import threading
from typing import Callable


_TRUNCATED_MARKER = '\n...[truncated]'
_READ_CHUNK_SIZE = 4096
_IS_WINDOWS = sys.platform == 'win32'
_REDACTED = '[redacted]'

# Sensitive substrings that flag an env-var-style ``KEY=value`` pair as worth
# redacting. The match is case-insensitive on the key only.
_SENSITIVE_KEY_HINTS = (
    'password',
    'passwd',
    'secret',
    'token',
    'api_key',
    'apikey',
    'access_key',
    'private_key',
    'auth',
    'credential',
)

# Patterns that always look like secrets regardless of surrounding key.
_REDACTION_PATTERNS: list[tuple[re.Pattern, str]] = [
    # AWS access key IDs.
    (re.compile(r'\b(?:AKIA|ASIA)[A-Z0-9]{16}\b'), _REDACTED),
    # Bearer tokens in HTTP-style headers.
    (re.compile(r'(?i)\b(bearer\s+)[A-Za-z0-9._\-=]{12,}'), r'\1' + _REDACTED),
    # JWTs (three base64url segments separated by dots).
    (re.compile(r'\beyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\b'), _REDACTED),
    # PEM-style private keys.
    (re.compile(r'-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----'), _REDACTED),
    # KEY=value where KEY contains a sensitive hint. Matches common shell-export
    # output (`AWS_SECRET_ACCESS_KEY=...`, `MY_API_TOKEN="..."`).
    (
        re.compile(
            r'(?im)^([A-Z][A-Z0-9_]*(?:'
            + '|'.join(re.escape(h) for h in _SENSITIVE_KEY_HINTS)
            + r')[A-Z0-9_]*)=(["\']?)\S+\2',
        ),
        r'\1=' + _REDACTED,
    ),
]


def redact_secrets(text: str) -> str:
    """Replace common secret shapes in *text* with ``[redacted]``.

    Best-effort: catches AWS keys, bearer tokens, JWTs, PEM private keys, and
    ``KEY=value`` lines where the key name contains a sensitive hint
    (password, secret, token, api_key, ...). It is not a substitute for not
    putting credentials on the command line in the first place.
    """
    if not text:
        return text
    out = text
    for pattern, repl in _REDACTION_PATTERNS:
        out = pattern.sub(repl, out)
    return out


def _harden_child() -> None:
    """preexec_fn: drop privileges and cap resources before ``execve``.

    POSIX-only — silently no-ops on platforms that don't expose ``prctl`` or
    the ``resource`` module. Each step is wrapped in its own try/except so a
    single failure does not derail the rest of the hardening.
    """
    # PR_SET_NO_NEW_PRIVS = 38: prevents the child (and its descendants) from
    # ever gaining privileges through setuid/setgid binaries or file caps.
    try:
        import ctypes

        libc = ctypes.CDLL(None, use_errno=True)
        libc.prctl(38, 1, 0, 0, 0)
    except Exception:
        pass

    try:
        import resource

        # 1 GiB cap on file size the child may write — prevents disk-fill.
        resource.setrlimit(resource.RLIMIT_FSIZE, (1 << 30, 1 << 30))
        # Open file descriptor cap.
        resource.setrlimit(resource.RLIMIT_NOFILE, (4096, 4096))
        # Spawnable subprocess cap (POSIX-only).
        if hasattr(resource, 'RLIMIT_NPROC'):
            resource.setrlimit(resource.RLIMIT_NPROC, (1024, 1024))
    except Exception:
        pass


def _rm_recursive(argv: list[str]) -> bool:
    """``rm`` invocation that recursively deletes (``-r`` / ``-rf`` / ``--recursive``)."""
    if argv[0] != 'rm':
        return False
    for tok in argv[1:]:
        if tok == '--recursive':
            return True
        if tok.startswith('-') and not tok.startswith('--') and ('r' in tok or 'R' in tok):
            return True
    return False


def _git_clean_force(argv: list[str]) -> bool:
    """``git clean`` with a force flag (the only way it actually deletes)."""
    if argv[0] != 'git' or len(argv) < 2 or argv[1] != 'clean':
        return False
    return any(
        tok == '--force' or (tok.startswith('-') and not tok.startswith('--') and 'f' in tok) for tok in argv[2:]
    )


def _truncate_to_zero(argv: list[str]) -> bool:
    """``truncate -s 0`` (or ``-s0``) — wipes file contents in place."""
    if argv[0] != 'truncate':
        return False
    for i, tok in enumerate(argv[1:], start=1):
        if tok == '-s' and i + 1 < len(argv) and argv[i + 1] == '0':
            return True
        if tok == '-s0' or tok == '--size=0':
            return True
    return False


_DESTRUCTIVE_CHECKS: list[tuple[str, Callable[[list[str]], bool]]] = [
    ('rm -r', _rm_recursive),
    ('dd of=', lambda a: a[0] == 'dd' and any(t.startswith('of=') for t in a[1:])),
    ('mkfs', lambda a: a[0] == 'mkfs' or a[0].startswith('mkfs.')),
    ('find -delete', lambda a: a[0] == 'find' and '-delete' in a[1:]),
    ('shred', lambda a: a[0] == 'shred'),
    ('git clean -f', _git_clean_force),
    ('chmod 000', lambda a: a[0] == 'chmod' and '000' in a[1:]),
    ('truncate -s 0', _truncate_to_zero),
]


def is_path_inside(child: str, parent: str) -> bool:
    """Return True if *child* (already realpath'd) is contained in *parent*.

    Used to jail a per-call ``working_dir`` override inside the configured
    node-level workingDir so an agent cannot escape via a sibling path.
    """
    try:
        rel = os.path.relpath(child, start=parent)
    except ValueError:
        # Different drive on Windows — definitely not inside.
        return False
    if rel == '.':
        return True
    return not rel.startswith('..') and not os.path.isabs(rel)


def is_destructive_argv(argv: list[str]) -> tuple[bool, str | None]:
    """Return ``(True, label)`` if *argv* matches a known-destructive pattern.

    Used by the IInstance layer to gate destructive operations behind an
    explicit ``confirm_destructive`` token in the call args. Only meaningful
    in argv mode — shell-mode commands aren't analysed because the shell can
    express equivalent operations (redirects, expansions) that flat-string
    analysis cannot reliably detect.
    """
    if not argv:
        return False, None
    for label, check in _DESTRUCTIVE_CHECKS:
        try:
            if check(argv):
                return True, label
        except (IndexError, AttributeError):
            continue
    return False, None


def _kill_process_tree(proc: subprocess.Popen) -> None:
    """Force-kill *proc* and every descendant it spawned through the shell."""
    if _IS_WINDOWS:
        # taskkill /T walks the process tree; /F forces termination.
        # Falls back to proc.kill() if taskkill itself can't run.
        try:
            subprocess.run(
                ['taskkill', '/T', '/F', '/PID', str(proc.pid)],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=5,
                check=False,
            )
        except (OSError, subprocess.SubprocessError):
            try:
                proc.kill()
            except OSError:
                pass
    else:
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        except (ProcessLookupError, PermissionError, OSError):
            try:
                proc.kill()
            except OSError:
                pass


def execute_command(
    command: str | list[str],
    *,
    cwd: str | None,
    env: dict[str, str],
    timeout: int,
    max_output_bytes: int,
    use_shell: bool = False,
    redact: bool = True,
) -> dict:
    """Run *command* and capture its result.

    With ``use_shell=False`` (default), *command* must be an argv list and
    the child is spawned directly without a shell — eliminating the entire
    shell-injection class. With ``use_shell=True``, *command* is a string
    interpreted by the host shell (enabling pipes, redirects, globs, ``&&``).

    On POSIX the child is launched through a ``preexec_fn`` that sets
    ``PR_SET_NO_NEW_PRIVS`` and applies rlimits (RLIMIT_FSIZE, RLIMIT_NOFILE,
    RLIMIT_NPROC) so a runaway command cannot escalate privileges or fill
    the host with files/processes/descriptors.

    Stdout and stderr are streamed through reader threads and capped at
    ``max_output_bytes`` per stream so a runaway command cannot exhaust
    engine memory. Once a stream's buffer reaches the cap, further chunks
    are drained and discarded so the child can finish writing without
    blocking on a full OS pipe (preserving its natural exit code).

    When *redact* is true (default) common secret shapes (AWS keys, bearer
    tokens, JWTs, PEM private keys, ``*_TOKEN`` / ``*_KEY`` / ``*PASSWORD*``
    env-var lines) are scrubbed from the captured output before return.
    """
    # Spawn the child in its own process group/session so we can later kill
    # the entire tree on timeout — otherwise shell-spawned grandchildren
    # outlive proc.kill() and keep our reader threads blocked on their pipes.
    popen_kwargs: dict = {
        'shell': use_shell,
        'cwd': cwd,
        'env': env,
        'stdout': subprocess.PIPE,
        'stderr': subprocess.PIPE,
    }
    if _IS_WINDOWS:
        popen_kwargs['creationflags'] = subprocess.CREATE_NEW_PROCESS_GROUP
    else:
        popen_kwargs['start_new_session'] = True
        popen_kwargs['preexec_fn'] = _harden_child

    try:
        proc = subprocess.Popen(command, **popen_kwargs)
    except FileNotFoundError as exc:
        return {
            'stdout': '',
            'stderr': f'Command not available: {exc}',
            'exit_code': 127,
            'timed_out': False,
            'truncated': False,
        }

    stdout_buf = bytearray()
    stderr_buf = bytearray()
    capped = {'stdout': False, 'stderr': False}

    def _drain(stream, buf: bytearray, key: str) -> None:
        """Append chunks to *buf* up to the cap; discard anything beyond it."""
        try:
            while True:
                chunk = stream.read(_READ_CHUNK_SIZE)
                if not chunk:
                    return
                remaining = max_output_bytes - len(buf)
                if remaining <= 0:
                    capped[key] = True
                    continue
                if len(chunk) > remaining:
                    buf.extend(chunk[:remaining])
                    capped[key] = True
                    continue
                buf.extend(chunk)
        except (ValueError, OSError):
            return

    t_out = threading.Thread(target=_drain, args=(proc.stdout, stdout_buf, 'stdout'), daemon=True)
    t_err = threading.Thread(target=_drain, args=(proc.stderr, stderr_buf, 'stderr'), daemon=True)
    t_out.start()
    t_err.start()

    timed_out = False
    try:
        exit_code = proc.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        timed_out = True
        _kill_process_tree(proc)
        proc.wait()
        exit_code = -1

    t_out.join()
    t_err.join()

    stdout_text = bytes(stdout_buf).decode('utf-8', errors='replace')
    stderr_text = bytes(stderr_buf).decode('utf-8', errors='replace')
    if redact:
        stdout_text = redact_secrets(stdout_text)
        stderr_text = redact_secrets(stderr_text)
    if capped['stdout']:
        stdout_text += _TRUNCATED_MARKER
    if capped['stderr']:
        stderr_text += _TRUNCATED_MARKER

    return {
        'stdout': stdout_text,
        'stderr': stderr_text,
        'exit_code': exit_code,
        'timed_out': timed_out,
        'truncated': capped['stdout'] or capped['stderr'],
    }


def build_environment(
    base_env: dict[str, str] | None,
    config_env: dict[str, str],
    call_env: dict[str, str] | None,
    *,
    allow_external_env: bool,
) -> dict[str, str]:
    """Merge env sources. Config-defined variables always take precedence over
    agent-supplied ones; both layer over the host process env.
    """
    merged: dict[str, str] = dict(base_env if base_env is not None else os.environ)
    if allow_external_env and call_env:
        for k, v in call_env.items():
            if not isinstance(k, str) or not k:
                continue
            merged[k] = '' if v is None else str(v)
    for k, v in config_env.items():
        merged[k] = v
    return merged
