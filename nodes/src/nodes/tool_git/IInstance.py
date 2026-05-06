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
Git tool node instance.

Each git operation is exposed as an ``@tool_function``-discoverable method on
``IInstance`` via the local ``@_tool`` decorator, which combines the framework
decorator with envelope stripping, strict schema validation, read-only
guarding, and uniform error formatting. There is no explicit ``invoke`` /
``_dispatch`` / ``_call`` chain — ``IInstanceBase.invoke`` walks the class for
``__tool_meta__``-stamped methods and dispatches by tool name.

Tool names match method names (no ``git.`` prefix). Every method receives a
single ``args`` dict that has already been envelope-stripped and
schema-validated; on error the method returns ``{'error': '…'}`` rather than
raising.
"""

from __future__ import annotations

import functools
from typing import Any, Callable, Dict, Optional, Union

import pygit2

from rocketlib import IInstanceBase, tool_function

from .git_repo import GitError, scrub_credentials
from .IGlobal import IGlobal

# ---------------------------------------------------------------------------
# Envelope stripping
# ---------------------------------------------------------------------------
#
# Agent harnesses commonly attach metadata to every tool call that is not part
# of any tool's input_schema. We strip these before validation so the agent
# doesn't get spurious "unknown parameter" errors for them on every call.
#
# - "input": LangChain-style nested-args wrapper (sometimes a dict to merge,
#   sometimes None when the agent has no extra args).
# - "repo_path": some agents conflate the node-level config with per-call
#   args; tool_git binds the repo at IGlobal.beginGlobal time, never per-call.
# - "security_context": added by some sandboxed agent runtimes.
_ENVELOPE_KEYS = frozenset({'input', 'repo_path', 'security_context'})


def _strip_envelope(args: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """Merge nested ``input`` dict into top level and drop envelope keys.

    Returns a fresh dict; *args* is not mutated. Returns ``{}`` for non-dict input.
    """
    if not isinstance(args, dict):
        return {}
    nested = args.get('input')
    if isinstance(nested, dict):
        # Top-level keys win on conflict — matches tool_github._normalize behaviour.
        merged = {**nested, **{k: v for k, v in args.items() if k != 'input'}}
    else:
        merged = dict(args)
    return {k: v for k, v in merged.items() if k not in _ENVELOPE_KEYS}


# ---------------------------------------------------------------------------
# Schema validation
# ---------------------------------------------------------------------------


def _validate_args(input_schema: Dict[str, Any], tool_name: str, args: Dict[str, Any]) -> None:
    """Reject any *args* keys not declared in *input_schema*.

    Raises ValueError listing the allowed parameters so the agent gets
    actionable feedback. Without this, an unknown key is silently dropped and
    the call returns a default-valued result the agent then misreads (the
    symptom that landed ``include_remote`` in production).
    """
    allowed = set((input_schema.get('properties') or {}).keys())
    unknown = sorted(k for k in args if k not in allowed)
    if not unknown:
        return
    if allowed:
        raise ValueError(f'{tool_name}: unknown parameter(s) {unknown}. Allowed parameters: {sorted(allowed)}.')
    raise ValueError(f'{tool_name}: this tool takes no parameters; received unexpected: {unknown}.')


# ---------------------------------------------------------------------------
# Typed argument helpers
# ---------------------------------------------------------------------------


def _bool_arg(args: Dict[str, Any], key: str, default: bool = False) -> bool:
    """Extract a boolean arg; raise ValueError if the value is not a bool."""
    v = args.get(key, default)
    if isinstance(v, bool):
        return v
    # JSON null deserialises to None — treat it the same as an absent key.
    if v is None:
        return default
    raise ValueError(f'{key} must be a boolean')


def _int_arg_in_range(args: Dict[str, Any], key: str, default: int, lo: int, hi: int) -> int:
    """Extract an integer arg in [lo, hi]; raise ValueError if out of range or wrong type."""
    v = args.get(key, default)
    if isinstance(v, bool) or not isinstance(v, int):
        raise ValueError(f'{key} must be an integer between {lo} and {hi}')
    if not lo <= v <= hi:
        raise ValueError(f'{key} must be between {lo} and {hi}')
    return v


# ---------------------------------------------------------------------------
# @_tool decorator — combines @tool_function with policy + validation
# ---------------------------------------------------------------------------


# is_write may be a static bool or a callable(args) -> bool. The callable form
# is for op-sensitive tools like stash, where ``op='list'`` is read-only but
# ``op='push'`` mutates state.
_IsWrite = Union[bool, Callable[[Dict[str, Any]], bool]]


def _tool(
    *,
    input_schema: Dict[str, Any],
    description: str,
    is_write: _IsWrite = False,
    output_schema: Optional[Dict[str, Any]] = None,
) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
    """Decorate an IInstance method as a discoverable git tool.

    Adds, in order, around the method body:

    1. Envelope strip (drops harness wrappers like ``input`` / ``repo_path``).
    2. Repo-initialised check (returns error if IGlobal.repo is None).
    3. Read-only guard for write tools (when ``read_only_mode`` is on).
    4. Strict schema validation (rejects unknown args with allowed-list).
    5. Body execution with uniform error catching — ``GitError``, ``ValueError``,
       ``KeyError`` (missing required arg), and ``pygit2.GitError`` (unwrapped
       libgit2 errors, with credentials scrubbed) all return ``{'error': '…'}``
       dicts rather than raising.

    The wrapped method receives a clean validated args dict and is expected to
    return a Python object (dict / list / scalar) that the framework will store
    as ``param.output`` and the engine will serialise to JSON for the agent.
    """

    def decorator(fn: Callable[..., Any]) -> Callable[..., Any]:
        tool_name = fn.__name__

        @functools.wraps(fn)
        def wrapper(self: 'IInstance', args: Optional[Dict[str, Any]]) -> Any:
            try:
                args = _strip_envelope(args)
                if self.IGlobal.repo is None:
                    return {'error': 'Git node is not initialised. Check node config.'}
                # Determine if THIS call mutates state. Static True/False covers
                # most tools; the callable form lets stash distinguish op='list'.
                writes = is_write(args) if callable(is_write) else is_write
                # Fail closed: missing attribute defaults to read-only.
                if writes and getattr(self.IGlobal.repo, 'read_only_mode', True):
                    return {
                        'error': (
                            f'{tool_name!r} is blocked in read-only mode. '
                            'Set readOnlyMode=false in node config to allow write operations.'
                        )
                    }
                _validate_args(input_schema, tool_name, args)
                return fn(self, args)
            except (GitError, ValueError) as exc:
                return {'error': str(exc)}
            except KeyError as exc:
                return {'error': f'Missing required parameter: {exc}'}
            except pygit2.GitError as exc:
                # Catch libgit2 errors that weren't wrapped by GitRepo (ref
                # parsing inside _resolve_ref, conflict during checkout, etc.).
                return {'error': scrub_credentials(exc)}

        # Stamp __tool_meta__ on the wrapper so IInstanceBase.invoke discovers it.
        return tool_function(
            input_schema=input_schema,
            description=description,
            output_schema=output_schema,
        )(wrapper)

    return decorator


# ---------------------------------------------------------------------------
# Shared schema fragments used by multiple tools
# ---------------------------------------------------------------------------

_REF_PROP = {'type': 'string', 'description': 'Commit SHA, branch name, or tag.'}


# ---------------------------------------------------------------------------
# IInstance — every public method below is a tool the agent can invoke
# ---------------------------------------------------------------------------


class IInstance(IInstanceBase):
    """RocketRide tool node that exposes git operations to an AI agent via pygit2."""

    IGlobal: IGlobal

    # ==================================================================
    # Group 1 — Repository
    # ==================================================================

    @_tool(
        input_schema={
            'type': 'object',
            'required': ['url', 'path'],
            'properties': {
                'url': {'type': 'string', 'description': 'Remote URL to clone (HTTPS or SSH).'},
                'path': {
                    'type': 'string',
                    'description': 'Local filesystem path to clone into (must not already contain a repo).',
                },
                'branch': {
                    'type': 'string',
                    'description': 'Branch to check out after cloning (default: remote HEAD).',
                },
            },
        },
        description='Clone a remote git repository to a local path. Returns clone summary including the checked-out branch and HEAD SHA.',
        is_write=True,
    )
    def clone(self, args: Dict[str, Any]) -> Any:
        """Clone a remote repository."""
        return self.IGlobal.repo.clone(url=args['url'], path=args['path'], branch=args.get('branch') or None)

    @_tool(
        input_schema={
            'type': 'object',
            'required': ['path'],
            'properties': {
                'path': {
                    'type': 'string',
                    'description': 'Filesystem path where the new repository should be created.',
                },
                'initial_branch': {'type': 'string', 'description': 'Name for the initial branch (default: "main").'},
            },
        },
        description='Initialise a new empty git repository at the given path. Creates the directory if it does not exist.',
        is_write=True,
    )
    def init(self, args: Dict[str, Any]) -> Any:
        """Initialise a new empty repository."""
        return self.IGlobal.repo.init(path=args['path'], initial_branch=args.get('initial_branch') or 'main')

    # ==================================================================
    # Group 2 — Status & Info
    # ==================================================================

    @_tool(
        input_schema={'type': 'object', 'properties': {}, 'required': []},
        description='Return the working-tree status: current branch, staged files, unstaged modifications, and untracked files.',
    )
    def status(self, args: Dict[str, Any]) -> Any:
        """Working-tree status."""
        return self.IGlobal.repo.status()

    @_tool(
        input_schema={
            'type': 'object',
            'required': [],
            'properties': {
                'max_count': {
                    'type': 'integer',
                    'description': 'Maximum number of commits to return (1-200, default 20).',
                },
                'branch': {'type': 'string', 'description': 'Branch name to walk (default: current branch).'},
                'path': {'type': 'string', 'description': 'Filter commits to those that touch this path.'},
                'author': {'type': 'string', 'description': 'Filter commits by author name (substring match).'},
                'since': {'type': 'string', 'description': 'Show commits after this ISO-8601 date.'},
                'until': {'type': 'string', 'description': 'Show commits before this ISO-8601 date.'},
            },
        },
        description='Return commit history. Supports filtering by branch, file path, author name, and date range.',
    )
    def log(self, args: Dict[str, Any]) -> Any:
        """Commit history with optional filters."""
        return self.IGlobal.repo.log(
            max_count=_int_arg_in_range(args, 'max_count', 20, 1, 200),
            branch=args.get('branch') or None,
            path=args.get('path') or None,
            author=args.get('author') or None,
            since=args.get('since') or None,
            until=args.get('until') or None,
        )

    @_tool(
        input_schema={
            'type': 'object',
            'required': ['ref'],
            'properties': {'ref': {'type': 'string', 'description': 'Commit SHA, branch name, or tag to inspect.'}},
        },
        description='Show full details of a single commit: metadata, diff patch, and file-change statistics.',
    )
    def show(self, args: Dict[str, Any]) -> Any:
        """Show full commit details."""
        return self.IGlobal.repo.show(ref=args['ref'])

    # ==================================================================
    # Group 3 — Diff & Inspection
    # ==================================================================

    @_tool(
        input_schema={
            'type': 'object',
            'required': [],
            'properties': {
                'ref_a': {'type': 'string', 'description': 'First ref (branch, tag, SHA). Omit for working-tree diff.'},
                'ref_b': {
                    'type': 'string',
                    'description': 'Second ref. Only valid when ref_a is also set; omit for single-ref or working-tree diff.',
                },
                'path': {'type': 'string', 'description': 'Limit diff output to this file or directory.'},
                'staged': {'type': 'boolean', 'description': 'If true, diff the staged index against HEAD.'},
            },
        },
        description='Produce a unified diff. Can diff working tree vs HEAD, two refs, or the staged index vs HEAD.',
    )
    def diff(self, args: Dict[str, Any]) -> Any:
        """Unified diff."""
        ref_a = args.get('ref_a') or None
        ref_b = args.get('ref_b') or None
        if ref_b and not ref_a:
            raise ValueError('ref_b requires ref_a to be set')
        return self.IGlobal.repo.diff(
            ref_a=ref_a,
            ref_b=ref_b,
            path=args.get('path') or None,
            staged=_bool_arg(args, 'staged', False),
        )

    @_tool(
        input_schema={
            'type': 'object',
            'required': ['path'],
            'properties': {
                'path': {'type': 'string', 'description': 'Repo-relative path to the file.'},
                'ref': {'type': 'string', 'description': 'Commit or branch to blame at (default: HEAD).'},
            },
        },
        description='Return per-line blame for a file: which commit and author last modified each line.',
    )
    def blame(self, args: Dict[str, Any]) -> Any:
        """Per-line blame."""
        return self.IGlobal.repo.blame(path=args['path'], ref=args.get('ref') or None)

    @_tool(
        input_schema={
            'type': 'object',
            'required': ['path', 'ref'],
            'properties': {
                'path': {'type': 'string', 'description': 'Repo-relative path to the file.'},
                'ref': _REF_PROP,
            },
        },
        description='Return the raw content of a file at a specific commit or ref.',
    )
    def file_at(self, args: Dict[str, Any]) -> Any:
        """File content at a specific ref."""
        return self.IGlobal.repo.file_at(path=args['path'], ref=args['ref'])

    @_tool(
        input_schema={
            'type': 'object',
            'required': ['path', 'content'],
            'properties': {
                'path': {'type': 'string', 'description': 'Repo-relative path to write (e.g. "README.md").'},
                'content': {'type': 'string', 'description': 'Full text content to write to the file.'},
            },
        },
        description='Write text content to a file in the working tree (creates or overwrites). Call stage then commit after writing to save the change.',
        is_write=True,
    )
    def write_file(self, args: Dict[str, Any]) -> Any:
        """Write text content to a file in the working tree."""
        return self.IGlobal.repo.write_file(path=args['path'], content=args['content'])

    # ==================================================================
    # Group 4 — Staging & Commits
    # ==================================================================

    @_tool(
        input_schema={
            'type': 'object',
            'required': ['paths'],
            'properties': {
                'paths': {
                    'type': 'array',
                    'items': {'type': 'string'},
                    'description': 'List of repo-relative file paths to stage.',
                },
            },
        },
        description='Stage files for the next commit (equivalent to git add). Deleted files are removed from the index.',
        is_write=True,
    )
    def stage(self, args: Dict[str, Any]) -> Any:
        """Stage files for the next commit."""
        paths = args.get('paths')
        if not isinstance(paths, list) or not paths or any(not isinstance(p, str) or not p for p in paths):
            raise ValueError('paths must be a non-empty list of non-empty strings')
        return self.IGlobal.repo.stage(paths=paths)

    @_tool(
        input_schema={
            'type': 'object',
            'required': ['message'],
            'properties': {
                'message': {'type': 'string', 'description': 'Commit message.'},
                'author_name': {'type': 'string', 'description': 'Author name (falls back to repo config).'},
                'author_email': {'type': 'string', 'description': 'Author email (falls back to repo config).'},
            },
        },
        description='Create a commit from the current staged index.',
        is_write=True,
    )
    def commit(self, args: Dict[str, Any]) -> Any:
        """Create a commit from the staged index."""
        return self.IGlobal.repo.commit(
            message=args['message'],
            author_name=args.get('author_name') or '',
            author_email=args.get('author_email') or '',
        )

    @_tool(
        input_schema={
            'type': 'object',
            'required': ['op'],
            'properties': {
                'op': {'type': 'string', 'enum': ['push', 'pop', 'list', 'drop'], 'description': 'Stash operation.'},
                'message': {'type': 'string', 'description': 'Optional label for the stash entry (push only).'},
                'index': {'type': 'integer', 'description': 'Stash index to pop or drop (default 0).'},
            },
        },
        description='Manage the git stash. Operations: push, pop, list, drop.',
        # op='list' is read-only; everything else mutates state.
        is_write=lambda a: (a.get('op') or 'push').lower() != 'list',
    )
    def stash(self, args: Dict[str, Any]) -> Any:
        """Manage stash entries (push/pop/list/drop)."""
        return self.IGlobal.repo.stash(
            op=args.get('op') or 'push',
            message=args.get('message') or '',
            index=args.get('index', 0),
        )

    # ==================================================================
    # Group 5 — Branches
    # ==================================================================

    @_tool(
        input_schema={
            'type': 'object',
            'required': [],
            'properties': {
                'remote': {'type': 'boolean', 'description': 'If true, include remote-tracking branches.'},
                'all_branches': {'type': 'boolean', 'description': 'If true, include both local and remote branches.'},
            },
        },
        description='List local branches, and optionally remote-tracking branches.',
    )
    def branch_list(self, args: Dict[str, Any]) -> Any:
        """List branches."""
        return self.IGlobal.repo.branch_list(
            remote=_bool_arg(args, 'remote', False),
            all_branches=_bool_arg(args, 'all_branches', False),
        )

    @_tool(
        input_schema={
            'type': 'object',
            'required': ['name'],
            'properties': {
                'name': {'type': 'string', 'description': 'Name for the new branch.'},
                'from_ref': {'type': 'string', 'description': 'Branch, tag, or SHA to branch from (default: HEAD).'},
            },
        },
        description='Create a new branch, optionally from a specific ref.',
        is_write=True,
    )
    def branch_create(self, args: Dict[str, Any]) -> Any:
        """Create a new branch."""
        return self.IGlobal.repo.branch_create(name=args['name'], from_ref=args.get('from_ref') or None)

    @_tool(
        input_schema={
            'type': 'object',
            'required': ['branch'],
            'properties': {'branch': {'type': 'string', 'description': 'Name of the branch to check out.'}},
        },
        description='Check out an existing local branch.',
        is_write=True,
    )
    def checkout(self, args: Dict[str, Any]) -> Any:
        """Check out an existing branch."""
        return self.IGlobal.repo.checkout(branch=args['branch'])

    @_tool(
        input_schema={
            'type': 'object',
            'required': ['name'],
            'properties': {
                'name': {'type': 'string', 'description': 'Branch name to delete.'},
                'force': {
                    'type': 'boolean',
                    'description': 'If true, force-delete the branch even if unmerged. Blocked when safeMode=true.',
                },
            },
        },
        description='Delete a branch. Normal deletion is always allowed. Force deletion (force=true) is blocked when safeMode=true.',
        is_write=True,
    )
    def branch_delete(self, args: Dict[str, Any]) -> Any:
        """Delete a branch."""
        return self.IGlobal.repo.branch_delete(name=args['name'], force=_bool_arg(args, 'force', False))

    @_tool(
        input_schema={
            'type': 'object',
            'required': ['branch'],
            'properties': {
                'branch': {'type': 'string', 'description': 'Name of the branch to merge into the current branch.'},
            },
        },
        description='Merge a branch into the current branch. Fast-forwards if possible, otherwise creates a merge commit. Raises on conflicts.',
        is_write=True,
    )
    def merge(self, args: Dict[str, Any]) -> Any:
        """Merge a branch into the current branch."""
        return self.IGlobal.repo.merge(branch=args['branch'])

    # ==================================================================
    # Group 6 — Remote
    # ==================================================================

    @_tool(
        input_schema={
            'type': 'object',
            'required': [],
            'properties': {
                'remote': {'type': 'string', 'description': 'Remote name (default: "origin").'},
                'branch': {'type': 'string', 'description': 'Specific branch to fetch (default: all refs).'},
            },
        },
        description='Fetch updates from a remote without merging.',
        is_write=True,
    )
    def fetch(self, args: Dict[str, Any]) -> Any:
        """Fetch from a remote."""
        return self.IGlobal.repo.fetch(remote=args.get('remote') or 'origin', branch=args.get('branch') or None)

    @_tool(
        input_schema={
            'type': 'object',
            'required': [],
            'properties': {
                'remote': {'type': 'string', 'description': 'Remote name (default: "origin").'},
                'branch': {'type': 'string', 'description': 'Branch to pull (default: current branch).'},
            },
        },
        description='Fetch from a remote and fast-forward merge the current branch.',
        is_write=True,
    )
    def pull(self, args: Dict[str, Any]) -> Any:
        """Fetch then fast-forward merge."""
        return self.IGlobal.repo.pull(remote=args.get('remote') or 'origin', branch=args.get('branch') or None)

    @_tool(
        input_schema={
            'type': 'object',
            'required': [],
            'properties': {
                'remote': {'type': 'string', 'description': 'Remote name (default: "origin").'},
                'branch': {'type': 'string', 'description': 'Branch to push (default: current branch).'},
                'force': {'type': 'boolean', 'description': 'Force-push. Blocked when safeMode=true.'},
            },
        },
        description='Push the current (or specified) branch to a remote. Force-push is blocked unless safeMode=false.',
        is_write=True,
    )
    def push(self, args: Dict[str, Any]) -> Any:
        """Push to a remote."""
        return self.IGlobal.repo.push(
            remote=args.get('remote') or 'origin',
            branch=args.get('branch') or None,
            force=_bool_arg(args, 'force', False),
        )

    # ==================================================================
    # Group 7 — Search
    # ==================================================================

    @_tool(
        input_schema={
            'type': 'object',
            'required': ['pattern'],
            'properties': {
                'pattern': {'type': 'string', 'description': 'Regular expression to search for.'},
                'ref': {'type': 'string', 'description': 'Commit or branch to search (default: HEAD).'},
                'path': {'type': 'string', 'description': 'Limit search to files under this path prefix.'},
                'ignore_case': {'type': 'boolean', 'description': 'Case-insensitive matching (default: false).'},
                'max_results': {
                    'type': 'integer',
                    'description': 'Maximum number of matches to return (1-10000, default 1000). Search stops once this many hits are collected.',
                },
            },
        },
        description='Search tracked file contents for a regex pattern. Returns file, line number, and matching line for each hit. Capped at max_results hits to keep responses bounded.',
    )
    def grep(self, args: Dict[str, Any]) -> Any:
        """Regex search across tracked files."""
        return self.IGlobal.repo.grep(
            pattern=args['pattern'],
            ref=args.get('ref') or None,
            path=args.get('path') or None,
            ignore_case=_bool_arg(args, 'ignore_case', False),
            max_results=_int_arg_in_range(args, 'max_results', 1000, 1, 10000),
        )

    @_tool(
        input_schema={
            'type': 'object',
            'required': [],
            'properties': {
                'path': {'type': 'string', 'description': 'Only list files under this path prefix.'},
                'untracked': {'type': 'boolean', 'description': 'If true, also return untracked files.'},
            },
        },
        description='List all tracked files in the repository, optionally filtered by path prefix.',
    )
    def ls_files(self, args: Dict[str, Any]) -> Any:
        """List tracked files."""
        return self.IGlobal.repo.ls_files(
            path=args.get('path') or None,
            untracked=_bool_arg(args, 'untracked', False),
        )
