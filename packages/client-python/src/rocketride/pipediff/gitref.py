# MIT License
#
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in all
# copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.

"""
Git ref resolution for ``rocketride diff --git <ref> <file.pipe>``.

This module reads a pipeline file's contents at a given git ref so the working
tree can be diffed against history (for example ``rocketride diff --git HEAD
pipeline.pipe``). It shells out to ``git show`` via :mod:`subprocess` with an
argument list — never a shell string — so pipeline paths and refs cannot inject
shell commands.

Like the rest of :mod:`rocketride.pipediff`, this never contacts the RocketRide
engine or the network; ``git`` is the only external process invoked.

Functions:
    resolve_git_ref: Return the parsed pipeline at ``ref``, or ``None`` if the
        file does not exist in that ref (treated by the caller as an all-added
        pipeline).
"""

from __future__ import annotations

import json
import os
import subprocess

from .engine import PipeDiffError, load_pipe

# Upper bound so a wedged git process can never hang the CLI indefinitely.
_GIT_TIMEOUT_SECONDS = 30


def resolve_git_ref(ref: str, file_path: str) -> dict | None:
    """
    Load a pipeline file's contents at a specific git ref.

    Resolves ``file_path`` to its repository-relative location, verifies that
    ``ref`` names a commit, and runs ``git show <ref>:<relative-path>`` to
    retrieve the file as it existed at ``ref``, then parses and validates the
    result. Used to diff a working-tree
    ``.pipe`` file against an arbitrary commit, branch, or tag.

    Args:
        ref: A git revision (commit sha, branch, tag, ``HEAD``, ``HEAD~1``, ...).
        file_path: Path to the working-tree ``.pipe`` file (absolute or relative
            to the current working directory).

    Returns:
        The parsed and validated pipeline ``dict`` at ``ref``, or ``None`` if the
        file does not exist in ``ref`` (the caller treats this as "everything is
        new").

    Raises:
        PipeDiffError: If the path is not inside a git repository, the ref is
            unknown (or does not name a commit), ``git`` is unavailable or times
            out, or the retrieved contents are not a valid pipeline.
    """
    # realpath (not just abspath) so the file resolves to the same physical path
    # that ``git rev-parse --show-toplevel`` reports, keeping relpath consistent
    # even when the repo is reached through a symlinked directory.
    abs_path = os.path.realpath(file_path)
    file_dir = os.path.dirname(abs_path) or '.'

    repo_root = _repository_root(file_dir, file_path)
    rel_path = os.path.relpath(abs_path, repo_root).replace(os.sep, '/')
    spec = f'{ref}:{rel_path}'

    # "Ref unknown" and "path absent from a known ref" must not be confused: the
    # first is a user error (exit 2), the second means "everything is new". Both
    # are decided on a git exit code, never on the wording of git's diagnostic —
    # a ref whose *name* contains a phrase like "does not exist in" is echoed
    # back in that diagnostic, and matching on it would silently downgrade a bad
    # ref into an all-added diff.
    verified = _run_git(
        ['-C', repo_root, 'rev-parse', '--verify', '--quiet', f'{ref}^{{commit}}'],
        f'verifying ref {ref}',
    )
    if verified.returncode != 0:
        detail = verified.stderr.strip()
        suffix = f': {detail}' if detail else ''
        raise PipeDiffError(f'Unknown git ref {ref!r}{suffix}')

    # ``cat-file -e`` is the machine-readable existence check: exit 0 when the
    # object named by <ref>:<path> exists in that (already verified) ref, non-zero
    # when it does not.
    present = _run_git(['-C', repo_root, 'cat-file', '-e', spec], f'checking for {spec}')
    if present.returncode != 0:
        return None

    result = _run_git(['-C', repo_root, 'show', spec], f'reading {spec}')
    if result.returncode != 0:
        raise PipeDiffError(f'git show {spec} failed: {result.stderr.strip()}')

    try:
        obj = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise PipeDiffError(f'Invalid JSON in {spec}: {exc}') from exc
    return load_pipe(obj)


def _repository_root(file_dir: str, file_path: str) -> str:
    """
    Resolve the git repository root that contains ``file_dir``.

    Args:
        file_dir: A directory inside the repository (the file's parent).
        file_path: The original path, used only for error context.

    Returns:
        The absolute path to the repository top level.

    Raises:
        PipeDiffError: If ``file_dir`` is not inside a git repository (or git
            otherwise fails to resolve the top level).
    """
    result = _run_git(
        ['-C', file_dir, 'rev-parse', '--show-toplevel'],
        f'resolving repository for {file_path}',
    )
    if result.returncode != 0:
        raise PipeDiffError(f'Not a git repository (or unable to resolve it) for {file_path}: {result.stderr.strip()}')
    return result.stdout.strip()


def _run_git(args: list[str], context: str) -> subprocess.CompletedProcess:
    """
    Run a ``git`` subcommand with a fixed argument list and no shell.

    Args:
        args: Arguments passed to ``git`` (already split; never a shell string).
        context: A short description of the operation for error messages.

    Returns:
        The completed process (callers inspect ``returncode``/``stdout``/
        ``stderr``).

    Raises:
        PipeDiffError: If ``git`` is not found on ``PATH``, the call times out, or
            git's output is not decodable as UTF-8 (a blob that is not a text
            pipe file, for instance).
    """
    try:
        return subprocess.run(
            ['git', *args],
            capture_output=True,
            text=True,
            encoding='utf-8',
            timeout=_GIT_TIMEOUT_SECONDS,
        )
    except FileNotFoundError as exc:
        raise PipeDiffError('git executable not found; --git requires git on PATH') from exc
    except subprocess.TimeoutExpired as exc:
        raise PipeDiffError(f'git timed out while {context}') from exc
    except UnicodeDecodeError as exc:
        raise PipeDiffError(f'git output is not valid UTF-8 while {context}: {exc}') from exc
