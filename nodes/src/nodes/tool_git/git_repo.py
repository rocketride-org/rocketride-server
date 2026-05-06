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
pygit2-based git repository wrapper.

All git operations go through libgit2 (via pygit2).  No host ``git`` binary
is required — libgit2 is bundled inside the pygit2 wheel.

Public surface
--------------
GitRepo          — main class, one instance per configured node
GitError         — raised on any git operation failure
"""

from __future__ import annotations

import os
import re
import stat
import tempfile
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Generator, List, Optional

from depends import depends  # type: ignore

depends(os.path.join(os.path.dirname(os.path.realpath(__file__)), 'requirements.txt'))

import pygit2


# ---------------------------------------------------------------------------
# pygit2 constant compatibility (names changed across versions)
# ---------------------------------------------------------------------------


def _c(name: str, fallback: int) -> int:
    """Return pygit2 constant by name, using fallback if the attribute is absent."""
    return getattr(pygit2, name, fallback)


_GIT_SORT_TIME = _c('GIT_SORT_TIME', 2)

_GIT_STATUS_INDEX_NEW = _c('GIT_STATUS_INDEX_NEW', 1)
_GIT_STATUS_INDEX_MODIFIED = _c('GIT_STATUS_INDEX_MODIFIED', 2)
_GIT_STATUS_INDEX_DELETED = _c('GIT_STATUS_INDEX_DELETED', 4)
_GIT_STATUS_INDEX_RENAMED = _c('GIT_STATUS_INDEX_RENAMED', 8)
_GIT_STATUS_INDEX_TYPECHANGE = _c('GIT_STATUS_INDEX_TYPECHANGE', 16)
_GIT_STATUS_WT_MODIFIED = _c('GIT_STATUS_WT_MODIFIED', 256)
_GIT_STATUS_WT_DELETED = _c('GIT_STATUS_WT_DELETED', 512)
_GIT_STATUS_WT_TYPECHANGE = _c('GIT_STATUS_WT_TYPECHANGE', 1024)
_GIT_STATUS_WT_RENAMED = _c('GIT_STATUS_WT_RENAMED', 2048)
_GIT_STATUS_WT_NEW = _c('GIT_STATUS_WT_NEW', 128)

_GIT_MERGE_ANALYSIS_UP_TO_DATE = _c('GIT_MERGE_ANALYSIS_UP_TO_DATE', 2)
_GIT_MERGE_ANALYSIS_FASTFORWARD = _c('GIT_MERGE_ANALYSIS_FASTFORWARD', 4)
_GIT_MERGE_ANALYSIS_NORMAL = _c('GIT_MERGE_ANALYSIS_NORMAL', 8)

_GIT_RESET_HARD = _c('GIT_RESET_HARD', 3)

# libgit2 credential type bitmask (passed as ``allowed_types`` to credential callbacks).
# Names changed from GIT_CREDTYPE_* to GIT_CREDENTIAL_* in libgit2 1.0; try both.
_GIT_CREDENTIAL_USERPASS_PLAINTEXT = _c('GIT_CREDENTIAL_USERPASS_PLAINTEXT', _c('GIT_CREDTYPE_USERPASS_PLAINTEXT', 1))
_GIT_CREDENTIAL_SSH_KEY = _c('GIT_CREDENTIAL_SSH_KEY', _c('GIT_CREDTYPE_SSH_KEY', 2))


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------


class GitError(Exception):
    """Raised when a git operation fails."""


# ---------------------------------------------------------------------------
# Auth callbacks
# ---------------------------------------------------------------------------


class _TokenCallbacks(pygit2.RemoteCallbacks):
    """HTTPS token / username+password credentials."""

    def __init__(self, username: str, token: str) -> None:
        """Store HTTPS credentials."""
        super().__init__()
        self._username = username or 'git'
        self._token = token

    def credentials(
        self,
        url: str,
        username_from_url: Optional[str],
        allowed_types: int,
    ) -> pygit2.UserPass:
        """Return a UserPass credential object for libgit2."""
        if not (allowed_types & _GIT_CREDENTIAL_USERPASS_PLAINTEXT):
            raise GitError(
                'Server does not accept token/password authentication. Set authType="ssh" and configure sshKey instead.'
            )
        return pygit2.UserPass(self._username, self._token)


class _SshCallbacks(pygit2.RemoteCallbacks):
    """SSH key credentials — key content written to a temp file."""

    def __init__(self, key_content: str, passphrase: str) -> None:
        """Store SSH key material; temp file is created lazily in credentials()."""
        super().__init__()
        self._key_content = key_content
        self._passphrase = passphrase
        self._tmp_path: Optional[str] = None

    def credentials(
        self,
        url: str,
        username_from_url: Optional[str],
        allowed_types: int,
    ) -> pygit2.Keypair:
        """Write the SSH key to a temp file on first call and return a Keypair."""
        if not (allowed_types & _GIT_CREDENTIAL_SSH_KEY):
            raise GitError(
                'Server does not accept SSH key authentication. '
                'Set authType="token" and configure a personal access token instead.'
            )
        # Write the private key to a temp file so libgit2 can read it.
        # The file is cleaned up in close().
        if self._tmp_path is None:
            fd = tempfile.NamedTemporaryFile(mode='w', suffix='.pem', delete=False)
            try:
                fd.write(self._key_content)
            finally:
                fd.close()
            self._tmp_path = fd.name
            # Restrict permissions: owner read-only
            os.chmod(self._tmp_path, stat.S_IRUSR)

        username = username_from_url or 'git'
        return pygit2.Keypair(
            username,
            pubkey='',
            privkey=self._tmp_path,
            passphrase=self._passphrase or '',
        )

    def close(self) -> None:
        """Delete the temporary key file if it was created."""
        if self._tmp_path is not None:
            try:
                os.unlink(self._tmp_path)
            except OSError:
                pass
            self._tmp_path = None


# ---------------------------------------------------------------------------
# Helper utilities
# ---------------------------------------------------------------------------


def scrub_credentials(exc: Exception) -> str:
    """Scrub potential credentials from a libgit2 error message."""
    # Redacts 'https://user:pass@host' to 'https://<redacted>@host'
    # The [^/]+@ pattern matches up to the last @ before a path separator.
    return re.sub(r'https?://[^/]+@', 'https://<redacted>@', str(exc))


def _sig(repo: pygit2.Repository, name: str = '', email: str = '') -> pygit2.Signature:
    """Build a git signature, falling back to repo config then defaults."""
    cfg_name = ''
    cfg_email = ''
    try:
        cfg_name = repo.config['user.name']
        cfg_email = repo.config['user.email']
    except (KeyError, pygit2.GitError):
        pass
    return pygit2.Signature(
        name or cfg_name or 'RocketRide Agent',
        email or cfg_email or 'agent@rocketride.local',
    )


def _commit_to_dict(commit: pygit2.Commit) -> Dict[str, Any]:
    """Convert a pygit2 Commit to a serialisable dict."""
    return {
        'sha': str(commit.id),
        'short_sha': str(commit.id)[:8],
        'message': commit.message.strip(),
        'author': commit.author.name,
        'author_email': commit.author.email,
        'date': datetime.fromtimestamp(commit.author.time, tz=timezone.utc).isoformat(),
        'committer': commit.committer.name,
    }


def _entry_to_dict(entry: pygit2.IndexEntry) -> Dict[str, str]:
    """Serialise a pygit2 IndexEntry to a plain dict."""
    return {'path': entry.path, 'id': str(entry.id)}


# ---------------------------------------------------------------------------
# Main class
# ---------------------------------------------------------------------------


class GitRepo:
    """
    Thin wrapper around a pygit2.Repository providing all tool operations.

    Parameters
    ----------
    repo_path:
        Absolute path to an existing local repository.
    auth_type:
        One of ``"none"``, ``"token"``, ``"ssh"``.
    username:
        Git username for token auth.
    token:
        Personal access token / password for token auth.
    ssh_key:
        PEM-encoded SSH private key content for SSH auth.
    ssh_passphrase:
        Passphrase for the SSH key (may be empty).
    safe_mode:
        When ``True``, destructive operations (force-push, deleting unmerged
        branches) raise ``GitError`` instead of executing.
    read_only_mode:
        When ``True``, *all* write operations (clone, init, write_file, stage,
        commit, stash push/pop/drop, branch create/delete, checkout, merge,
        fetch, pull, push) raise ``GitError``. Strictly stronger than
        ``safe_mode`` — overrides it for the operations it covers.
    """

    # Class-level annotations: these are also instance attributes (assigned in
    # __init__), but declaring them here makes them visible to introspection
    # (e.g. unittest.mock.create_autospec) and matches the IGlobal style.
    safe_mode: bool = True
    read_only_mode: bool = True

    def __init__(
        self,
        *,
        repo_path: str,
        auth_type: str = 'none',
        username: str = '',
        token: str = '',
        ssh_key: str = '',
        ssh_passphrase: str = '',
        safe_mode: bool = True,
        read_only_mode: bool = True,
    ) -> None:
        """Configure the wrapper and optionally open an existing local repository.

        Args:
            repo_path: Absolute path to an existing local repository, or empty
                string to defer opening (use ``clone`` / ``init`` at runtime).
            auth_type: Remote authentication method — ``"none"``, ``"token"``,
                or ``"ssh"``.
            username: Git username for token-based HTTPS authentication.
            token: Personal access token or password for HTTPS authentication.
            ssh_key: PEM-encoded SSH private key content.
            ssh_passphrase: Passphrase for the SSH private key (may be empty).
            safe_mode: When ``True``, blocks destructive operations such as
                force-push and force branch deletion.
            read_only_mode: When ``True``, blocks every mutating operation —
                strictly stronger than ``safe_mode``. Read-only tools (status,
                log, show, diff, blame, file_at, branch_list, grep, ls_files,
                stash list) remain available.
        """
        self._repo_path = repo_path
        self._auth_type = auth_type.lower()
        self._username = username
        self._token = token
        self._ssh_key = ssh_key
        self._ssh_passphrase = ssh_passphrase
        self.safe_mode = safe_mode
        self.read_only_mode = read_only_mode
        self._repo: Optional[pygit2.Repository] = None

        if repo_path:
            self._repo = self._open(repo_path)

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _open(path: str) -> pygit2.Repository:
        """Open an existing repository at *path*, raising GitError if not found."""
        try:
            return pygit2.Repository(path)
        except pygit2.GitError as exc:
            raise GitError(f'Not a git repository: {path!r} — {exc}') from exc

    def open(self, path: str) -> None:
        """Open an existing local repository at *path* and bind it to this wrapper.

        Validates that *path* exists and is a directory before opening, then sets
        ``self._repo`` and ``self._repo_path``. Raises GitError on any failure
        (missing path, not a directory, or not a git repository).
        """
        p = Path(path)
        if not p.exists():
            raise GitError(f'repoPath {path!r} does not exist')
        if not p.is_dir():
            raise GitError(f'repoPath {path!r} is not a directory')
        self._repo = self._open(path)
        self._repo_path = path

    @contextmanager
    def _callbacks(self) -> Generator[Optional[pygit2.RemoteCallbacks], None, None]:
        """Context manager that yields the appropriate RemoteCallbacks."""
        cb: Optional[pygit2.RemoteCallbacks] = None
        if self._auth_type == 'token':
            cb = _TokenCallbacks(self._username, self._token)
        elif self._auth_type == 'ssh':
            cb = _SshCallbacks(self._ssh_key, self._ssh_passphrase)
        try:
            yield cb
        finally:
            if isinstance(cb, _SshCallbacks):
                cb.close()

    def _require_repo(self) -> pygit2.Repository:
        """Return the active repository or raise GitError if none is loaded."""
        if self._repo is None:
            raise GitError('No repository loaded. Set repoPath in config or call clone first.')
        return self._repo

    def _safe_guard(self, operation: str) -> None:
        """Raise GitError if safe_mode is enabled, blocking the named operation."""
        if self.safe_mode:
            raise GitError(f'{operation!r} is blocked in safe mode. Set safeMode=false in node config to allow it.')

    def _resolve_ref(self, repo: pygit2.Repository, ref: str) -> pygit2.Commit:
        """Resolve a ref string (branch name, tag, sha) to a Commit."""
        try:
            obj = repo.revparse_single(ref)
            if obj.type_str == 'tag':
                obj = obj.peel(pygit2.Commit)
            if obj.type_str != 'commit':
                raise GitError(f'{ref!r} does not resolve to a commit')
            return obj  # type: ignore[return-value]
        except (KeyError, pygit2.GitError):
            # KeyError: missing ref. pygit2.GitError: malformed ref syntax.
            raise GitError(f'Ref {ref!r} not found') from None

    # ------------------------------------------------------------------
    # Group 1 — Repository
    # ------------------------------------------------------------------

    def clone(self, url: str, path: str, branch: Optional[str] = None) -> Dict[str, Any]:
        """Clone *url* into *path*."""
        dest = Path(path)
        if dest.exists():
            if dest.is_file():
                raise GitError(f'Destination {path!r} exists as a file')
            if dest.is_dir() and any(dest.iterdir()):
                raise GitError(f'Destination {path!r} exists and is not empty')
        with self._callbacks() as cb:
            try:
                kwargs: Dict[str, Any] = {}
                if branch:
                    kwargs['checkout_branch'] = branch
                if cb:
                    kwargs['callbacks'] = cb
                repo = pygit2.clone_repository(url, path, **kwargs)
            except pygit2.GitError as exc:
                raise GitError(f'Clone failed: {scrub_credentials(exc)}') from exc

        self._repo = repo
        self._repo_path = path
        head = repo.head.shorthand
        return {
            'status': 'cloned',
            'url': url,
            'path': path,
            'branch': head,
            'sha': str(repo.head.target),
        }

    def init(self, path: str, initial_branch: str = 'main') -> Dict[str, Any]:
        """Initialise a new empty repository at *path*."""
        Path(path).mkdir(parents=True, exist_ok=True)
        try:
            repo = pygit2.init_repository(path, initial_head=initial_branch)
        except pygit2.GitError as exc:
            raise GitError(f'Init failed: {exc}') from exc
        self._repo = repo
        self._repo_path = path
        return {'status': 'initialised', 'path': path, 'branch': initial_branch}

    # ------------------------------------------------------------------
    # Group 2 — Status & Info
    # ------------------------------------------------------------------

    def status(self) -> Dict[str, Any]:
        """Return working-tree status."""
        repo = self._require_repo()
        staged: List[str] = []
        unstaged: List[str] = []
        untracked: List[str] = []

        flags_staged = (
            _GIT_STATUS_INDEX_NEW
            | _GIT_STATUS_INDEX_MODIFIED
            | _GIT_STATUS_INDEX_DELETED
            | _GIT_STATUS_INDEX_RENAMED
            | _GIT_STATUS_INDEX_TYPECHANGE
        )
        flags_unstaged = (
            _GIT_STATUS_WT_MODIFIED | _GIT_STATUS_WT_DELETED | _GIT_STATUS_WT_TYPECHANGE | _GIT_STATUS_WT_RENAMED
        )

        for filepath, flags in repo.status().items():
            if flags & flags_staged:
                staged.append(filepath)
            if flags & flags_unstaged:
                unstaged.append(filepath)
            if flags & _GIT_STATUS_WT_NEW:
                untracked.append(filepath)

        branch = repo.head.shorthand if not repo.head_is_unborn else '(unborn)'
        return {
            'branch': branch,
            'staged': staged,
            'unstaged': unstaged,
            'untracked': untracked,
            'clean': not staged and not unstaged and not untracked,
        }

    def log(
        self,
        max_count: int = 20,
        branch: Optional[str] = None,
        path: Optional[str] = None,
        author: Optional[str] = None,
        since: Optional[str] = None,
        until: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        """Return commit history."""
        repo = self._require_repo()
        max_count = min(max(1, int(max_count)), 200)

        if branch:
            try:
                start = repo.branches[branch].target
            except KeyError:
                raise GitError(f'Branch {branch!r} not found') from None
        elif repo.head_is_unborn:
            return []
        else:
            start = repo.head.target

        since_ts = _parse_ts(since) if since else None
        until_ts = _parse_ts(until) if until else None

        commits = []
        for commit in repo.walk(start, _GIT_SORT_TIME):
            if since_ts and commit.author.time < since_ts:
                break
            if until_ts and commit.author.time > until_ts:
                continue
            if author and author.lower() not in commit.author.name.lower():
                continue
            if path and not _commit_touches_path(repo, commit, path):
                continue
            commits.append(_commit_to_dict(commit))
            if len(commits) >= max_count:
                break

        return commits

    def show(self, ref: str) -> Dict[str, Any]:
        """Return full commit details including diff."""
        repo = self._require_repo()
        commit = self._resolve_ref(repo, ref)
        result = _commit_to_dict(commit)
        if commit.parents:
            diff = repo.diff(commit.parents[0].tree, commit.tree)
        else:
            # Initial commit — diff against an empty tree so all lines show as additions.
            empty = repo.TreeBuilder().write()
            diff = repo.diff(repo.get(empty), commit.tree)
        result['diff'] = diff.patch or ''
        result['stats'] = {
            'files_changed': diff.stats.files_changed,
            'insertions': diff.stats.insertions,
            'deletions': diff.stats.deletions,
        }
        return result

    # ------------------------------------------------------------------
    # Group 3 — Diff & Inspection
    # ------------------------------------------------------------------

    def diff(
        self,
        ref_a: Optional[str] = None,
        ref_b: Optional[str] = None,
        path: Optional[str] = None,
        staged: bool = False,
    ) -> Dict[str, Any]:
        """Produce a unified diff."""
        repo = self._require_repo()

        if staged:
            # Index vs HEAD
            if repo.head_is_unborn:
                d = repo.index.diff_to_tree()
            else:
                head_commit = repo.revparse_single('HEAD')
                d = repo.index.diff_to_tree(head_commit.peel(pygit2.Tree))
        elif ref_a and ref_b:
            tree_a = self._resolve_ref(repo, ref_a).peel(pygit2.Tree)
            tree_b = self._resolve_ref(repo, ref_b).peel(pygit2.Tree)
            d = repo.diff(tree_a, tree_b)
        elif ref_a:
            tree_a = self._resolve_ref(repo, ref_a).peel(pygit2.Tree)
            d = repo.diff(tree_a)
        else:
            # Working tree vs HEAD
            if repo.head_is_unborn:
                d = repo.index.diff_to_tree()
            else:
                d = repo.diff(repo.revparse_single('HEAD').peel(pygit2.Tree))

        patch = d.patch or ''
        if path:
            filtered = _filter_diff_by_path(patch, path)
            return filtered

        return {
            'patch': patch,
            'files_changed': d.stats.files_changed,
            'insertions': d.stats.insertions,
            'deletions': d.stats.deletions,
        }

    def blame(self, path: str, ref: Optional[str] = None) -> List[Dict[str, Any]]:
        """Return per-line blame for *path*."""
        repo = self._require_repo()
        kwargs: Dict[str, Any] = {}
        if ref:
            kwargs['newest_commit'] = self._resolve_ref(repo, ref).id
        try:
            blame_obj = repo.blame(path, **kwargs)
        except pygit2.GitError as exc:
            raise GitError(f'blame failed for {path!r}: {exc}') from exc

        # Read file content from the same ref used for blame, not always HEAD.
        lookup_ref = ref or 'HEAD'
        try:
            entry = self._resolve_ref(repo, lookup_ref).peel(pygit2.Tree)[path]
        except KeyError:
            raise GitError(f'{path!r} not found in {lookup_ref!r}') from None
        blob = repo.get(entry.id)
        lines = (blob.data.decode('utf-8', errors='replace')).splitlines()

        result = []
        for hunk in blame_obj:
            for line_offset in range(hunk.lines_in_hunk):
                line_no = hunk.final_start_line_number + line_offset
                line_text = lines[line_no - 1] if line_no - 1 < len(lines) else ''
                result.append(
                    {
                        'line': line_no,
                        'content': line_text,
                        'sha': str(hunk.final_commit_id)[:8],
                        'author': hunk.final_signature.name,
                        'date': datetime.fromtimestamp(hunk.final_signature.time, tz=timezone.utc).isoformat(),
                    }
                )
        return result

    def file_at(self, path: str, ref: str) -> Dict[str, Any]:
        """Return file content at a specific commit/ref."""
        repo = self._require_repo()
        commit = self._resolve_ref(repo, ref)
        try:
            entry = commit.peel(pygit2.Tree)[path]
        except KeyError:
            raise GitError(f'{path!r} not found in {ref!r}') from None
        blob = repo.get(entry.id)
        if blob is None or blob.type_str != 'blob':
            raise GitError(f'{path!r} is not a file at {ref!r}')
        content = blob.data.decode('utf-8', errors='replace')
        return {
            'path': path,
            'ref': ref,
            'sha': str(blob.id)[:8],
            'size': blob.size,
            'content': content,
        }

    def write_file(self, path: str, content: str) -> Dict[str, Any]:
        """Write *content* to *path* in the working tree (creates or overwrites)."""
        repo = self._require_repo()
        workdir = Path(repo.workdir).resolve()
        full = (workdir / path).resolve()
        if not full.is_relative_to(workdir):
            raise GitError(f'Path {path!r} escapes the repository working directory')
        # Prevent writes to .git directory
        if full.is_relative_to(workdir / '.git'):
            raise GitError(f'Path {path!r} is inside the .git directory')
        full.parent.mkdir(parents=True, exist_ok=True)
        full.write_text(content, encoding='utf-8')
        return {'path': path, 'size': len(content.encode('utf-8')), 'status': 'written'}

    # ------------------------------------------------------------------
    # Group 4 — Staging & Commits
    # ------------------------------------------------------------------

    def stage(self, paths: List[str]) -> Dict[str, Any]:
        """Stage files (add to index)."""
        repo = self._require_repo()
        workdir = Path(repo.workdir).resolve()
        repo.index.read()
        staged = []
        for p in paths:
            full = (workdir / p).resolve()
            if not full.is_relative_to(workdir):
                raise GitError(f'Path {p!r} escapes the repository working directory')
            # Prevent staging files inside .git directory
            if full.is_relative_to(workdir / '.git'):
                raise GitError(f'Path {p!r} is inside the .git directory')
            if not full.exists():
                # Deleted file — remove from index
                try:
                    repo.index.remove(p)
                    staged.append(f'removed: {p}')
                except KeyError:
                    pass
            else:
                repo.index.add(p)
                staged.append(p)
        repo.index.write()
        return {'staged': staged, 'count': len(staged)}

    def commit(
        self,
        message: str,
        author_name: str = '',
        author_email: str = '',
    ) -> Dict[str, Any]:
        """Create a commit from the current index."""
        repo = self._require_repo()
        repo.index.read()
        tree = repo.index.write_tree()
        sig = _sig(repo, author_name, author_email)
        parents = [] if repo.head_is_unborn else [repo.head.target]
        sha = repo.create_commit('HEAD', sig, sig, message, tree, parents)
        return {
            'sha': str(sha),
            'short_sha': str(sha)[:8],
            'message': message,
            'author': sig.name,
        }

    def stash(
        self,
        op: str = 'push',
        message: str = '',
        index: int = 0,
    ) -> Dict[str, Any]:
        """Push, pop, list, or drop stash entries."""
        repo = self._require_repo()
        op = op.lower()

        if op == 'push':
            sig = _sig(repo)
            msg = message or f'stash: {datetime.now(tz=timezone.utc).isoformat()}'
            try:
                oid = repo.stash(sig, msg)
            except pygit2.GitError as exc:
                raise GitError(f'stash push failed: {scrub_credentials(exc)}') from exc
            return {'status': 'stashed', 'sha': str(oid)[:8], 'message': msg}

        if op == 'list':
            entries = []
            for i, entry in enumerate(repo.listall_stashes()):
                entries.append(
                    {
                        'index': i,
                        'message': entry.message,
                        'sha': str(entry.commit_id)[:8],
                    }
                )
            return {'stashes': entries, 'count': len(entries)}

        if op == 'pop':
            try:
                repo.stash_pop(index)
            except pygit2.GitError as exc:
                raise GitError(f'stash pop failed: {scrub_credentials(exc)}') from exc
            return {'status': 'popped', 'index': index}

        if op == 'drop':
            try:
                repo.stash_drop(index)
            except pygit2.GitError as exc:
                raise GitError(f'stash drop failed: {scrub_credentials(exc)}') from exc
            return {'status': 'dropped', 'index': index}

        raise GitError(f'Unknown stash op {op!r}. Use push, pop, list, or drop.')

    # ------------------------------------------------------------------
    # Group 5 — Branches
    # ------------------------------------------------------------------

    def branch_list(
        self,
        remote: bool = False,
        all_branches: bool = False,
    ) -> Dict[str, Any]:
        """List branches."""
        repo = self._require_repo()
        current = repo.head.shorthand if not repo.head_is_unborn else None
        local = [{'name': b, 'current': b == current} for b in repo.branches.local]
        result: Dict[str, Any] = {'local': local}
        if remote or all_branches:
            result['remote'] = list(repo.branches.remote)
        return result

    def branch_create(
        self,
        name: str,
        from_ref: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Create a new branch."""
        repo = self._require_repo()
        ref = from_ref or ('HEAD' if not repo.head_is_unborn else None)
        if ref is None:
            raise GitError('Cannot create branch in an empty repository — make an initial commit first')
        commit = self._resolve_ref(repo, ref)
        try:
            branch = repo.branches.create(name, commit)
        except pygit2.GitError as exc:
            raise GitError(f'branch create failed: {exc}') from exc
        return {'name': branch.branch_name, 'sha': str(branch.target)[:8]}

    def checkout(self, branch: str) -> Dict[str, Any]:
        """Checkout an existing branch."""
        repo = self._require_repo()
        try:
            b = repo.branches[branch]
        except KeyError:
            raise GitError(f'Branch {branch!r} not found') from None
        repo.checkout(b)
        return {
            'branch': branch,
            'sha': str(repo.head.target)[:8],
        }

    def branch_delete(self, name: str, force: bool = False) -> Dict[str, Any]:
        """Delete a branch."""
        repo = self._require_repo()
        if force:
            self._safe_guard('force-deleting a branch')
        try:
            b = repo.branches[name]
        except KeyError:
            raise GitError(f'Branch {name!r} not found') from None

        if not force and not repo.head_is_unborn:
            branch_tip = b.target
            head_tip = repo.head.target
            try:
                base = repo.merge_base(branch_tip, head_tip)
                if base != branch_tip:
                    raise GitError(
                        f'Branch {name!r} is not fully merged into HEAD. '
                        'Use force=true to delete it anyway (requires safeMode=false).'
                    )
            except pygit2.GitError:
                raise GitError(
                    f'Branch {name!r} has no common ancestor with HEAD. '
                    'Use force=true to delete it anyway (requires safeMode=false).'
                ) from None

        b.delete()
        return {'deleted': name}

    def merge(self, branch: str) -> Dict[str, Any]:
        """Merge *branch* into the current branch."""
        repo = self._require_repo()
        try:
            their_branch = repo.branches[branch]
        except KeyError:
            raise GitError(f'Branch {branch!r} not found') from None

        analysis, _ = repo.merge_analysis(their_branch.target)

        if analysis & _GIT_MERGE_ANALYSIS_UP_TO_DATE:
            return {'status': 'up_to_date', 'branch': branch}

        if analysis & _GIT_MERGE_ANALYSIS_FASTFORWARD:
            repo.checkout_tree(repo.get(their_branch.target))
            repo.head.set_target(their_branch.target)
            return {
                'status': 'fast_forwarded',
                'branch': branch,
                'sha': str(their_branch.target)[:8],
            }

        if analysis & _GIT_MERGE_ANALYSIS_NORMAL:
            repo.merge(their_branch.target)
            if repo.index.conflicts:
                conflicts = [c.our.path for c in repo.index.conflicts if c.our]
                # Abort cleanly: clear MERGE_HEAD/MERGE_MSG and reset the index
                # and worktree to HEAD. Leaving the repo half-merged would
                # silently corrupt the next commit (which would create a
                # non-merge commit containing conflict markers).
                repo.state_cleanup()
                repo.reset(repo.head.target, _GIT_RESET_HARD)
                raise GitError(
                    f'Merge conflict in: {", ".join(conflicts)}. '
                    'Merge aborted (state reset to HEAD); resolve conflicts manually outside the agent and retry.'
                )
            tree = repo.index.write_tree()
            sig = _sig(repo)
            sha = repo.create_commit(
                'HEAD',
                sig,
                sig,
                f"Merge branch '{branch}'",
                tree,
                [repo.head.target, their_branch.target],
            )
            repo.state_cleanup()
            return {
                'status': 'merged',
                'branch': branch,
                'sha': str(sha)[:8],
            }

        raise GitError(f'Merge analysis result {analysis!r} not handled')

    # ------------------------------------------------------------------
    # Group 6 — Remote
    # ------------------------------------------------------------------

    def fetch(
        self,
        remote: str = 'origin',
        branch: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Fetch from a remote."""
        repo = self._require_repo()
        try:
            rem = repo.remotes[remote]
        except KeyError:
            raise GitError(f'Remote {remote!r} not found') from None
        with self._callbacks() as cb:
            kwargs: Dict[str, Any] = {}
            if cb:
                kwargs['callbacks'] = cb
            refspecs = [f'refs/heads/{branch}:refs/remotes/{remote}/{branch}'] if branch else []
            try:
                stats = rem.fetch(refspecs or None, **kwargs)
            except pygit2.GitError as exc:
                raise GitError(f'fetch failed: {scrub_credentials(exc)}') from exc
        return {
            'remote': remote,
            'received_objects': stats.received_objects,
            'indexed_objects': stats.indexed_objects,
            'total_deltas': stats.total_deltas,
        }

    def pull(
        self,
        remote: str = 'origin',
        branch: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Fetch then fast-forward merge."""
        fetch_result = self.fetch(remote, branch)
        repo = self._require_repo()

        target_branch = branch or (repo.head.shorthand if not repo.head_is_unborn else None)
        if not target_branch:
            return {**fetch_result, 'merge': 'skipped (empty repo)'}

        remote_ref = f'refs/remotes/{remote}/{target_branch}'
        try:
            remote_commit = repo.references[remote_ref].peel(pygit2.Commit)
        except (KeyError, pygit2.GitError):
            return {**fetch_result, 'merge': 'skipped (remote ref not found)'}

        analysis, _ = repo.merge_analysis(remote_commit.id)

        if analysis & _GIT_MERGE_ANALYSIS_UP_TO_DATE:
            return {**fetch_result, 'merge': 'up_to_date'}

        if analysis & _GIT_MERGE_ANALYSIS_FASTFORWARD:
            repo.checkout_tree(remote_commit)
            repo.head.set_target(remote_commit.id)
            return {**fetch_result, 'merge': 'fast_forwarded', 'sha': str(remote_commit.id)[:8]}

        raise GitError('Cannot fast-forward. The branch has diverged. Merge manually or rebase before pulling.')

    def push(
        self,
        remote: str = 'origin',
        branch: Optional[str] = None,
        force: bool = False,
    ) -> Dict[str, Any]:
        """Push to a remote."""
        if force:
            self._safe_guard('force push')
        repo = self._require_repo()
        target = branch or (repo.head.shorthand if not repo.head_is_unborn else None)
        if not target:
            raise GitError('Cannot push: repository HEAD is unborn (no commits yet)')
        try:
            rem = repo.remotes[remote]
        except KeyError:
            raise GitError(f'Remote {remote!r} not found') from None

        prefix = '+' if force else ''
        refspec = f'{prefix}refs/heads/{target}:refs/heads/{target}'
        with self._callbacks() as cb:
            kwargs: Dict[str, Any] = {}
            if cb:
                kwargs['callbacks'] = cb
            try:
                rem.push([refspec], **kwargs)
            except pygit2.GitError as exc:
                raise GitError(f'push failed: {scrub_credentials(exc)}') from exc

        return {'remote': remote, 'branch': target, 'status': 'pushed'}

    # ------------------------------------------------------------------
    # Group 7 — Search
    # ------------------------------------------------------------------

    def grep(
        self,
        pattern: str,
        ref: Optional[str] = None,
        path: Optional[str] = None,
        ignore_case: bool = False,
        max_results: int = 1000,
    ) -> List[Dict[str, Any]]:
        """Search tracked files for a pattern. Stops after *max_results* hits."""
        repo = self._require_repo()
        flags = re.IGNORECASE if ignore_case else 0
        try:
            rx = re.compile(pattern, flags)
        except re.error as exc:
            raise GitError(f'Invalid pattern {pattern!r}: {exc}') from exc

        if ref:
            commit = self._resolve_ref(repo, ref)
            tree = commit.peel(pygit2.Tree)
        elif repo.head_is_unborn:
            return []
        else:
            tree = repo.head.peel(pygit2.Tree)

        results: List[Dict[str, Any]] = []
        _grep_tree(repo, tree, rx, path or '', results, max_results=max(1, int(max_results)))
        return results

    def ls_files(
        self,
        path: Optional[str] = None,
        untracked: bool = False,
    ) -> Dict[str, Any]:
        """List tracked (and optionally untracked) files."""
        repo = self._require_repo()
        repo.index.read()

        tracked = [e.path for e in repo.index if not path or _path_matches(e.path, path)]

        result: Dict[str, Any] = {'tracked': tracked, 'count': len(tracked)}

        if untracked:
            untracked_files = [
                f
                for f, flags in repo.status().items()
                if flags & _GIT_STATUS_WT_NEW and (not path or _path_matches(f, path))
            ]
            result['untracked'] = untracked_files

        return result


# ---------------------------------------------------------------------------
# Private helpers
# ---------------------------------------------------------------------------


def _path_matches(entry_path: str, prefix: str) -> bool:
    """Return True if *entry_path* equals *prefix* or lives under it as a directory."""
    prefix = prefix.rstrip('/')
    return entry_path == prefix or entry_path.startswith(prefix + '/')


def _parse_ts(value: str) -> int:
    """Parse an ISO date string to a Unix timestamp."""
    try:
        dt = datetime.fromisoformat(value.replace('Z', '+00:00'))
        return int(dt.timestamp())
    except ValueError as exc:
        raise GitError(f'Invalid date {value!r}: {exc}') from exc


def _commit_touches_path(
    repo: pygit2.Repository,
    commit: pygit2.Commit,
    path: str,
) -> bool:
    """Return True if *commit* modifies *path*."""
    if not commit.parents:
        # For the initial commit, inspect the tree directly instead of assuming a match.
        try:
            tree = commit.peel(pygit2.Tree)
            tree[path]
            return True
        except KeyError:
            return False
        except pygit2.GitError:
            return False
    parent = commit.parents[0]
    diff = repo.diff(parent.tree, commit.tree)
    return any(_path_matches(d.delta.new_file.path, path) or _path_matches(d.delta.old_file.path, path) for d in diff)


# Matches the header line of a per-file section in a unified diff.
# Group 1 captures the b-side path, which handles filenames with spaces
# better than splitting on whitespace.
_DIFF_HEADER_RE = re.compile(r'^diff --git a/.+ b/(.+)$')


def _filter_diff_by_path(patch: str, path: str) -> Dict[str, Any]:
    """Filter a unified diff by path and recalculate stats. Returns filtered patch and counts."""
    lines = patch.splitlines(keepends=True)
    result: List[str] = []
    include = False
    files_changed = 0
    insertions = 0
    deletions = 0

    for line in lines:
        if line.startswith('diff --git'):
            m = _DIFF_HEADER_RE.match(line.rstrip())
            if m:
                file_path = m.group(1)
                # Match exact path or path/ prefix
                include = file_path == path or file_path.startswith(path + '/')
                if include:
                    files_changed += 1
            else:
                include = False

        if include:
            result.append(line)
            # Count additions and deletions in hunks
            if line.startswith('+') and not line.startswith('+++'):
                insertions += 1
            elif line.startswith('-') and not line.startswith('---'):
                deletions += 1

    return {
        'patch': ''.join(result),
        'files_changed': files_changed,
        'insertions': insertions,
        'deletions': deletions,
    }


def _grep_tree(
    repo: pygit2.Repository,
    tree: pygit2.Tree,
    rx: Any,
    prefix: str,
    results: List[Dict[str, Any]],
    _path: str = '',
    *,
    max_results: int = 1000,
) -> None:
    """Recursively search a tree for lines matching *rx*. Stops once results hits *max_results*."""
    for entry in tree:
        if len(results) >= max_results:
            return
        entry_path = entry.name if not _path else f'{_path}/{entry.name}'
        obj = repo.get(entry.id)
        if obj is None:
            continue
        if obj.type_str == 'tree':
            # Recurse if this directory could contain files that satisfy the prefix.
            if not prefix or _path_matches(entry_path, prefix) or prefix.startswith(entry_path + '/'):
                _grep_tree(repo, obj, rx, prefix, results, entry_path, max_results=max_results)
        elif obj.type_str == 'blob':
            if prefix and not _path_matches(entry_path, prefix):
                continue
            try:
                text = obj.data.decode('utf-8', errors='replace')
            except (AttributeError, TypeError):
                # obj.data may be absent or non-bytes for unusual blob types
                continue
            for lineno, line in enumerate(text.splitlines(), 1):
                if rx.search(line):
                    results.append(
                        {
                            'file': entry_path,
                            'line': lineno,
                            'content': line,
                        }
                    )
                    if len(results) >= max_results:
                        return
