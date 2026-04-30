# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
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

import shutil
import tempfile
from pathlib import Path

from ai.common.config import Config
from rocketlib import IGlobalBase, OPEN_MODE, warning

from .git_repo import GitError, GitRepo


class IGlobal(IGlobalBase):
    """Global state for tool_git."""

    repo: GitRepo | None = None
    _tmp_dir: str | None = None  # set when we auto-cloned into a temp directory

    def beginGlobal(self) -> None:
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return

        cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)

        repo_path = str(cfg.get('repoPath') or '').strip()
        auth_type = str(cfg.get('authType') or 'none').strip().lower()
        username = str(cfg.get('username') or '').strip()
        token = str(cfg.get('token') or '').strip()
        ssh_key = str(cfg.get('sshKey') or '').strip()
        ssh_passphrase = str(cfg.get('sshPassphrase') or '').strip()
        safe_mode_raw = cfg.get('safeMode', True)
        safe_mode = _parse_bool(safe_mode_raw, default=True)

        # Validate auth config
        if auth_type == 'token' and not token:
            warning('tool_git: authType is "token" but no token is configured')
        if auth_type == 'ssh' and not ssh_key:
            warning('tool_git: authType is "ssh" but no sshKey is configured')

        # Build a GitRepo without an open repo first (auth config is always needed)
        git = GitRepo(
            repo_path='',
            auth_type=auth_type,
            username=username,
            token=token,
            ssh_key=ssh_key,
            ssh_passphrase=ssh_passphrase,
            safe_mode=safe_mode,
        )

        if _is_url(repo_path):
            # Auto-clone the remote URL into a fresh temp directory
            tmp = tempfile.mkdtemp(prefix='rocketride_git_')
            try:
                git.clone(url=repo_path, path=tmp)
            except Exception as exc:
                shutil.rmtree(tmp, ignore_errors=True)
                raise ValueError(f'tool_git: failed to clone {repo_path!r}: {exc}') from exc
            self._tmp_dir = tmp

        elif repo_path:
            # Local path — validate it exists and open it
            p = Path(repo_path)
            if not p.exists():
                raise ValueError(f'tool_git: repoPath {repo_path!r} does not exist')
            if not p.is_dir():
                raise ValueError(f'tool_git: repoPath {repo_path!r} is not a directory')
            try:
                git._repo = git._open(repo_path)
                git._repo_path = repo_path
            except GitError as exc:
                raise ValueError(str(exc)) from exc

        # else: no repoPath — git.clone / git.init can be called by the agent at runtime

        self.repo = git

    def validateConfig(self) -> None:
        try:
            cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
            auth_type = str(cfg.get('authType') or 'none').strip().lower()
            token = str(cfg.get('token') or '').strip()
            ssh_key = str(cfg.get('sshKey') or '').strip()

            if auth_type == 'token' and not token:
                warning('Token is required when Auth Type is "token"')
            if auth_type == 'ssh' and not ssh_key:
                warning('SSH Key is required when Auth Type is "ssh"')

            repo_path = str(cfg.get('repoPath') or '').strip()
            if repo_path and not _is_url(repo_path) and not Path(repo_path).exists():
                warning(f'repoPath {repo_path!r} does not exist on this machine')
        except Exception as exc:
            warning(str(exc))

    def endGlobal(self) -> None:
        self.repo = None
        if self._tmp_dir:
            shutil.rmtree(self._tmp_dir, ignore_errors=True)
            self._tmp_dir = None


def _is_url(value: str) -> bool:
    """Return True if value looks like a remote git URL."""
    return value.startswith(('http://', 'https://', 'git://', 'git@', 'ssh://'))


def _parse_bool(raw: object, default: bool = True) -> bool:
    if isinstance(raw, bool):
        return raw
    if isinstance(raw, str):
        value = raw.strip().lower()
        if value in {'1', 'true', 'yes', 'on'}:
            return True
        if value in {'0', 'false', 'no', 'off'}:
            return False
        return default
    return bool(raw) if raw is not None else default
