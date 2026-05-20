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
Git tool node — global (shared) state.

Reads node config (repo path/URL, auth credentials, safe-mode flag) and creates
a ``GitRepo`` instance shared across all IInstance invocations within the same
pipeline run.

If ``repoPath`` is a remote URL (starts with http://, https://, git://, or
git@), the repo is cloned into a temporary directory on ``beginGlobal`` and
that directory is deleted on ``endGlobal``.
"""

from __future__ import annotations

import os
import shutil
import stat
import sys
import tempfile
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlparse, urlunparse

from ai.common.config import Config
from rocketlib import IGlobalBase, OPEN_MODE, warning

from ai.common.utils import parse_bool

from .git_repo import GitError, GitRepo, scrub_credentials


# ---------------------------------------------------------------------------
# Filesystem cleanup helpers
# ---------------------------------------------------------------------------


def _force_writable_then_retry(func: Callable[..., Any], path: str, exc_info: Any) -> None:
    """Clear the read-only bit on *path* and retry *func* — rmtree onerror/onexc handler.

    libgit2 leaves pack files in ``.git/objects/pack/`` read-only on Windows, so a
    plain ``shutil.rmtree`` (or ``ignore_errors=True``) leaves orphan temp dirs in
    ``%TEMP%/rocketride_git_*``. Re-chmod and retry so the worktree is fully removed.
    """
    try:
        os.chmod(path, stat.S_IWRITE)
        func(path)
    except OSError:
        # Best-effort — don't let cleanup failures break the pipeline.
        pass


def _rmtree(path: str) -> None:
    """Remove *path* recursively, defeating Windows read-only attributes."""
    # Python 3.12 renamed onerror -> onexc; support both signatures.
    if sys.version_info >= (3, 12):
        shutil.rmtree(path, onexc=_force_writable_then_retry)
    else:
        shutil.rmtree(path, onerror=_force_writable_then_retry)


# ---------------------------------------------------------------------------
# Config constants
# ---------------------------------------------------------------------------


# Mirrors the enum in services.json's git.authType field.
_VALID_AUTH_TYPES = frozenset({'none', 'token', 'ssh'})


# ---------------------------------------------------------------------------
# IGlobal — pipeline-scoped state
# ---------------------------------------------------------------------------


class IGlobal(IGlobalBase):
    """Global state for tool_git."""

    repo: GitRepo | None = None
    _tmp_dir: str | None = None  # set when we auto-cloned into a temp directory

    def beginGlobal(self) -> None:
        """Initialise the GitRepo instance; clone remote URL or open local path if configured."""
        # Skip during canvas/preview opens — only build the repo when the pipeline actually runs.
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return

        # --- Read raw node config -----------------------------------------
        cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)

        repo_path = str(cfg.get('repoPath') or '').strip()
        auth_type = str(cfg.get('authType') or 'none').strip().lower()
        username = str(cfg.get('username') or '').strip()
        token = str(cfg.get('token') or '').strip()
        ssh_key = str(cfg.get('sshKey') or '').strip()
        ssh_passphrase = str(cfg.get('sshPassphrase') or '').strip()
        safe_mode_raw = cfg.get('safeMode', True)
        safe_mode = parse_bool(safe_mode_raw, default=True)
        read_only_mode_raw = cfg.get('readOnlyMode', True)
        read_only_mode = parse_bool(read_only_mode_raw, default=True)

        # --- Validate auth config -----------------------------------------
        # Unknown authType is downgraded to "none" rather than raising — this lets
        # purely local pipelines (no remote ops) still run with a misconfigured field.
        if auth_type not in _VALID_AUTH_TYPES:
            warning(
                f'tool_git: authType {auth_type!r} is not one of {sorted(_VALID_AUTH_TYPES)}; '
                'falling back to "none" — remote operations will fail.'
            )
            auth_type = 'none'
        if auth_type == 'token' and not token:
            warning('tool_git: authType is "token" but no token is configured')
        if auth_type == 'ssh' and not ssh_key:
            warning('tool_git: authType is "ssh" but no sshKey is configured')

        # --- Build the GitRepo wrapper ------------------------------------
        # Construct without an open repo first; the repo is bound below depending
        # on whether repoPath is a remote URL, a local path, or empty.
        git = GitRepo(
            repo_path='',
            auth_type=auth_type,
            username=username,
            token=token,
            ssh_key=ssh_key,
            ssh_passphrase=ssh_passphrase,
            safe_mode=safe_mode,
            read_only_mode=read_only_mode,
        )

        # --- Bind a repository to the wrapper -----------------------------
        if _is_url(repo_path):
            # Remote URL → clone into a fresh temp dir; cleaned up in endGlobal.
            tmp = tempfile.mkdtemp(prefix='rocketride_git_')
            try:
                git.clone(url=repo_path, path=tmp)
            except Exception as exc:
                # Cleanup on failed clone, then re-raise with credentials scrubbed.
                _rmtree(tmp)
                parsed = urlparse(repo_path)
                if not parsed.scheme and repo_path.startswith('git@'):
                    # git@host:org/repo SSH shorthand — no safe way to partially redact.
                    redacted = '<ssh-url>'
                else:
                    # Rebuild netloc as hostname[:port] — drops any userinfo.
                    safe_host = parsed.hostname or ''
                    if parsed.port:
                        safe_host = f'{safe_host}:{parsed.port}'
                    redacted = urlunparse((parsed.scheme, safe_host, parsed.path, '', '', ''))
                # libgit2 sometimes echoes the raw URL (with credentials) in error text.
                raise ValueError(f'tool_git: failed to clone {redacted!r}: {scrub_credentials(exc)}') from exc
            self._tmp_dir = tmp

        elif repo_path:
            # Local path → open in place; mutations persist on disk.
            try:
                git.open(repo_path)
            except GitError as exc:
                raise ValueError(f'tool_git: {exc}') from exc

        # else: no repoPath → leave repo unbound. The agent can call clone /
        # init at runtime to attach a repository.

        self.repo = git

    def validateConfig(self) -> None:
        """Emit warnings for invalid authType, missing credentials, or a non-existent local repoPath."""
        try:
            cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
            auth_type = str(cfg.get('authType') or 'none').strip().lower()
            token = str(cfg.get('token') or '').strip()
            ssh_key = str(cfg.get('sshKey') or '').strip()

            if auth_type not in _VALID_AUTH_TYPES:
                warning(f'Auth Type {auth_type!r} is not one of: {", ".join(sorted(_VALID_AUTH_TYPES))}')
            elif auth_type == 'token' and not token:
                warning('Token is required when Auth Type is "token"')
            elif auth_type == 'ssh' and not ssh_key:
                warning('SSH Key is required when Auth Type is "ssh"')

            repo_path = str(cfg.get('repoPath') or '').strip()
            if repo_path and not _is_url(repo_path) and not Path(repo_path).exists():
                warning(f'repoPath {repo_path!r} does not exist on this machine')
        except Exception as exc:
            warning(str(exc))

    def endGlobal(self) -> None:
        """Release the repo reference and delete any auto-cloned temp directory."""
        self.repo = None
        if self._tmp_dir:
            _rmtree(self._tmp_dir)
            self._tmp_dir = None


# ---------------------------------------------------------------------------
# Small config-parsing helpers
# ---------------------------------------------------------------------------


def _is_url(value: str) -> bool:
    """Return True if value looks like a remote git URL."""
    return value.startswith(('http://', 'https://', 'git://', 'git@', 'ssh://'))
