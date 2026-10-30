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
Hermetic git fixtures shared by the ``rocketride diff --git`` tests.

A test repository must never depend on, or change, the developer's git setup.
Left to inherit it, ``git commit`` can hang on a signing prompt, run a global
hook, or fail for want of an identity. So every git command a fixture runs:

- uses a fixture-local identity,
- has commit and tag signing switched off,
- ignores the user's and the system's git configuration and every hook,
- takes every path literally (a directory named ``:(top)x`` is not pathspec magic),
- gets no stdin and a timeout, so a prompt or a wedged process fails the test
  instead of hanging the run,

and none of it touches any global git setting: it is all per-command ``-c``
flags plus environment variables that :func:`isolate_git_environment` confines
to one test.
"""

import os
import subprocess

import pytest

# Longest a single fixture git command may run before the test fails.
GIT_TIMEOUT_SECONDS = 30

# Fixture-local identity; the .invalid TLD can never deliver mail.
_IDENTITY = {
    'GIT_AUTHOR_NAME': 'Fixture',
    'GIT_AUTHOR_EMAIL': 'fixture@example.invalid',
    'GIT_COMMITTER_NAME': 'Fixture',
    'GIT_COMMITTER_EMAIL': 'fixture@example.invalid',
}

# Per-command configuration that makes a commit non-interactive and hook-free.
_SAFE_CONFIG = (
    '-c',
    'commit.gpgsign=false',
    '-c',
    'tag.gpgsign=false',
    '-c',
    f'core.hooksPath={os.devnull}',
)


def hermetic_git_env(base=None):
    """
    Return ``base`` (default ``os.environ``) reduced to a hermetic git environment.

    Inherited ``GIT_*`` variables (``GIT_DIR``, ``GIT_INDEX_FILE``, a signing
    program, ...) are dropped, the user and system configuration files are
    pointed at nothing, and the fixture identity is set.
    """
    env = {key: value for key, value in (os.environ if base is None else base).items() if not key.startswith('GIT_')}
    env.update(_IDENTITY)
    env['GIT_CONFIG_GLOBAL'] = os.devnull
    env['GIT_CONFIG_NOSYSTEM'] = '1'
    env['GIT_TERMINAL_PROMPT'] = '0'
    return env


def isolate_git_environment(monkeypatch):
    """
    Make this test's process environment hermetic for git, then undo it.

    The code under test runs git too (``git show``, ``ls-tree``, ...), and the
    CLI subprocess tests copy ``os.environ``, so the isolation has to be in the
    test process itself and not only on the fixture's own commands.
    """
    for key in [key for key in os.environ if key.startswith('GIT_')]:
        monkeypatch.delenv(key)
    for key, value in hermetic_git_env({}).items():
        monkeypatch.setenv(key, value)


def run_git(repo, *args, check=True):
    """
    Run ``git <args>`` in ``repo`` hermetically and return the completed process.

    Raises:
        AssertionError: If ``check`` is set and git exits non-zero.
        subprocess.TimeoutExpired: If git runs longer than ``GIT_TIMEOUT_SECONDS``.
    """
    result = subprocess.run(
        ['git', '--literal-pathspecs', *_SAFE_CONFIG, *args],
        cwd=repo,
        env=hermetic_git_env(),
        stdin=subprocess.DEVNULL,
        capture_output=True,
        text=True,
        timeout=GIT_TIMEOUT_SECONDS,
    )
    if check:
        assert result.returncode == 0, f'git {" ".join(args)} failed: {result.stderr}'
    return result


def commit_all(repo, message='fixture', *paths):
    """Stage ``paths`` (default: everything) and commit them."""
    run_git(repo, 'add', '--', *(paths or ('.',)))
    run_git(repo, 'commit', '-q', '-m', message)


def init_repo(path, *files, message='init'):
    """
    Create a repository at ``path`` and commit ``files`` (names under it).

    Returns:
        A ``git(*args)`` callable bound to the repository.
    """

    def git(*args, check=True):
        return run_git(path, *args, check=check)

    git('init', '-q')
    commit_all(path, message, *files)
    return git


def make_symlink(link, target, directory=False):
    """
    Create the symbolic link ``link`` pointing at the text ``target``.

    Slashes in ``target`` become the platform's separator first: Windows resolves a
    relative link only when its text uses backslashes (a link written as ``a/b`` is
    created but cannot be opened, ``EINVAL``), and git reads the text back with
    slashes again, so what gets committed is the same on every platform.

    Only on Windows, and only when the account is not allowed to create links
    (it needs Developer Mode or elevation), the test is skipped; anywhere else, or
    for any other failure, the error is the test's.
    """
    text = os.fspath(target)
    if os.name == 'nt':
        text = text.replace('/', os.sep)
    try:
        os.symlink(text, link, target_is_directory=directory)
    except (OSError, NotImplementedError) as exc:
        if os.name == 'nt' and getattr(exc, 'winerror', None) == 1314:
            pytest.skip('this Windows account cannot create symbolic links (enable Developer Mode or run elevated)')
        raise
