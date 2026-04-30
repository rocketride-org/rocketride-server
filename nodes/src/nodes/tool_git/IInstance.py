# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Git tool node instance.

Exposes local git repository operations as agent tools: repository management,
status/info, diff/inspection, staging/commits, branches, remote, and search.
All git operations use pygit2 (libgit2) — no host git binary required.
"""

from __future__ import annotations

import json
from typing import Any, Dict, List

from rocketlib import IInstanceBase

from .git_repo import GitError
from .IGlobal import IGlobal

# ---------------------------------------------------------------------------
# Tool catalogue — (name, description, parameters schema)
# ---------------------------------------------------------------------------

_TOOLS: List[Dict[str, Any]] = [
    # Group 1 — Repository
    {
        'name': 'git.clone',
        'description': 'Clone a remote git repository to a local path. Returns clone summary including the checked-out branch and HEAD SHA.',
        'input_schema': {
            'type': 'object',
            'required': ['url', 'path'],
            'properties': {
                'url': {'type': 'string', 'description': 'Remote URL to clone (HTTPS or SSH).'},
                'path': {'type': 'string', 'description': 'Local filesystem path to clone into (must not already contain a repo).'},
                'branch': {'type': 'string', 'description': 'Branch to check out after cloning (default: remote HEAD).'},
            },
        },
    },
    {
        'name': 'git.init',
        'description': 'Initialise a new empty git repository at the given path. Creates the directory if it does not exist.',
        'input_schema': {
            'type': 'object',
            'required': ['path'],
            'properties': {
                'path': {'type': 'string', 'description': 'Filesystem path where the new repository should be created.'},
                'initial_branch': {'type': 'string', 'description': 'Name for the initial branch (default: "main").'},
            },
        },
    },
    # Group 2 — Status & Info
    {
        'name': 'git.status',
        'description': 'Return the working-tree status: current branch, staged files, unstaged modifications, and untracked files.',
        'input_schema': {'type': 'object', 'properties': {}, 'required': []},
    },
    {
        'name': 'git.log',
        'description': 'Return commit history. Supports filtering by branch, file path, author name, and date range.',
        'input_schema': {
            'type': 'object',
            'required': [],
            'properties': {
                'max_count': {'type': 'integer', 'description': 'Maximum number of commits to return (1-200, default 20).'},
                'branch': {'type': 'string', 'description': 'Branch name to walk (default: current branch).'},
                'path': {'type': 'string', 'description': 'Filter commits to those that touch this path.'},
                'author': {'type': 'string', 'description': 'Filter commits by author name (substring match).'},
                'since': {'type': 'string', 'description': 'Show commits after this ISO-8601 date.'},
                'until': {'type': 'string', 'description': 'Show commits before this ISO-8601 date.'},
            },
        },
    },
    {
        'name': 'git.show',
        'description': 'Show full details of a single commit: metadata, diff patch, and file-change statistics.',
        'input_schema': {
            'type': 'object',
            'required': ['ref'],
            'properties': {
                'ref': {'type': 'string', 'description': 'Commit SHA, branch name, or tag to inspect.'},
            },
        },
    },
    # Group 3 — Diff & Inspection
    {
        'name': 'git.diff',
        'description': 'Produce a unified diff. Can diff working tree vs HEAD, two refs, or the staged index vs HEAD.',
        'input_schema': {
            'type': 'object',
            'required': [],
            'properties': {
                'ref_a': {'type': 'string', 'description': 'First ref (branch, tag, SHA). Omit for working-tree diff.'},
                'ref_b': {'type': 'string', 'description': 'Second ref. Only valid when ref_a is also set; omit for single-ref or working-tree diff.'},
                'path': {'type': 'string', 'description': 'Limit diff output to this file or directory.'},
                'staged': {'type': 'boolean', 'description': 'If true, diff the staged index against HEAD.'},
            },
        },
    },
    {
        'name': 'git.blame',
        'description': 'Return per-line blame for a file: which commit and author last modified each line.',
        'input_schema': {
            'type': 'object',
            'required': ['path'],
            'properties': {
                'path': {'type': 'string', 'description': 'Repo-relative path to the file.'},
                'ref': {'type': 'string', 'description': 'Commit or branch to blame at (default: HEAD).'},
            },
        },
    },
    {
        'name': 'git.file_at',
        'description': 'Return the raw content of a file at a specific commit or ref.',
        'input_schema': {
            'type': 'object',
            'required': ['path', 'ref'],
            'properties': {
                'path': {'type': 'string', 'description': 'Repo-relative path to the file.'},
                'ref': {'type': 'string', 'description': 'Commit SHA, branch, or tag.'},
            },
        },
    },
    # Group 3b — Write file
    {
        'name': 'git.write_file',
        'description': ('Write text content to a file in the working tree (creates or overwrites). Call git.stage then git.commit after writing to save the change.'),
        'input_schema': {
            'type': 'object',
            'required': ['path', 'content'],
            'properties': {
                'path': {'type': 'string', 'description': 'Repo-relative path to write (e.g. "README.md").'},
                'content': {'type': 'string', 'description': 'Full text content to write to the file.'},
            },
        },
    },
    # Group 4 — Staging & Commits
    {
        'name': 'git.stage',
        'description': 'Stage files for the next commit (equivalent to git add). Deleted files are removed from the index.',
        'input_schema': {
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
    },
    {
        'name': 'git.commit',
        'description': 'Create a commit from the current staged index.',
        'input_schema': {
            'type': 'object',
            'required': ['message'],
            'properties': {
                'message': {'type': 'string', 'description': 'Commit message.'},
                'author_name': {'type': 'string', 'description': 'Author name (falls back to repo config).'},
                'author_email': {'type': 'string', 'description': 'Author email (falls back to repo config).'},
            },
        },
    },
    {
        'name': 'git.stash',
        'description': 'Manage the git stash. Operations: push, pop, list, drop.',
        'input_schema': {
            'type': 'object',
            'required': ['op'],
            'properties': {
                'op': {'type': 'string', 'enum': ['push', 'pop', 'list', 'drop'], 'description': 'Stash operation.'},
                'message': {'type': 'string', 'description': 'Optional label for the stash entry (push only).'},
                'index': {'type': 'integer', 'description': 'Stash index to pop or drop (default 0).'},
            },
        },
    },
    # Group 5 — Branches
    {
        'name': 'git.branch_list',
        'description': 'List local branches, and optionally remote-tracking branches.',
        'input_schema': {
            'type': 'object',
            'required': [],
            'properties': {
                'remote': {'type': 'boolean', 'description': 'If true, include remote-tracking branches.'},
                'all_branches': {'type': 'boolean', 'description': 'If true, include both local and remote branches.'},
            },
        },
    },
    {
        'name': 'git.branch_create',
        'description': 'Create a new branch, optionally from a specific ref.',
        'input_schema': {
            'type': 'object',
            'required': ['name'],
            'properties': {
                'name': {'type': 'string', 'description': 'Name for the new branch.'},
                'from_ref': {'type': 'string', 'description': 'Branch, tag, or SHA to branch from (default: HEAD).'},
            },
        },
    },
    {
        'name': 'git.checkout',
        'description': 'Check out an existing local branch.',
        'input_schema': {
            'type': 'object',
            'required': ['branch'],
            'properties': {
                'branch': {'type': 'string', 'description': 'Name of the branch to check out.'},
            },
        },
    },
    {
        'name': 'git.branch_delete',
        'description': 'Delete a branch. Normal deletion is always allowed. Force deletion (force=true) is blocked when safeMode=true.',
        'input_schema': {
            'type': 'object',
            'required': ['name'],
            'properties': {
                'name': {'type': 'string', 'description': 'Branch name to delete.'},
                'force': {'type': 'boolean', 'description': 'If true, force-delete the branch even if unmerged. Blocked when safeMode=true.'},
            },
        },
    },
    {
        'name': 'git.merge',
        'description': 'Merge a branch into the current branch. Fast-forwards if possible, otherwise creates a merge commit. Raises on conflicts.',
        'input_schema': {
            'type': 'object',
            'required': ['branch'],
            'properties': {
                'branch': {'type': 'string', 'description': 'Name of the branch to merge into the current branch.'},
            },
        },
    },
    # Group 6 — Remote
    {
        'name': 'git.fetch',
        'description': 'Fetch updates from a remote without merging.',
        'input_schema': {
            'type': 'object',
            'required': [],
            'properties': {
                'remote': {'type': 'string', 'description': 'Remote name (default: "origin").'},
                'branch': {'type': 'string', 'description': 'Specific branch to fetch (default: all refs).'},
            },
        },
    },
    {
        'name': 'git.pull',
        'description': 'Fetch from a remote and fast-forward merge the current branch.',
        'input_schema': {
            'type': 'object',
            'required': [],
            'properties': {
                'remote': {'type': 'string', 'description': 'Remote name (default: "origin").'},
                'branch': {'type': 'string', 'description': 'Branch to pull (default: current branch).'},
            },
        },
    },
    {
        'name': 'git.push',
        'description': 'Push the current (or specified) branch to a remote. Force-push is blocked unless safeMode=false.',
        'input_schema': {
            'type': 'object',
            'required': [],
            'properties': {
                'remote': {'type': 'string', 'description': 'Remote name (default: "origin").'},
                'branch': {'type': 'string', 'description': 'Branch to push (default: current branch).'},
                'force': {'type': 'boolean', 'description': 'Force-push. Blocked when safeMode=true.'},
            },
        },
    },
    # Group 7 — Search
    {
        'name': 'git.grep',
        'description': 'Search tracked file contents for a regex pattern. Returns file, line number, and matching line for each hit.',
        'input_schema': {
            'type': 'object',
            'required': ['pattern'],
            'properties': {
                'pattern': {'type': 'string', 'description': 'Regular expression to search for.'},
                'ref': {'type': 'string', 'description': 'Commit or branch to search (default: HEAD).'},
                'path': {'type': 'string', 'description': 'Limit search to files under this path prefix.'},
                'ignore_case': {'type': 'boolean', 'description': 'Case-insensitive matching (default: false).'},
            },
        },
    },
    {
        'name': 'git.ls_files',
        'description': 'List all tracked files in the repository, optionally filtered by path prefix.',
        'input_schema': {
            'type': 'object',
            'required': [],
            'properties': {
                'path': {'type': 'string', 'description': 'Only list files under this path prefix.'},
                'untracked': {'type': 'boolean', 'description': 'If true, also return untracked files.'},
            },
        },
    },
]

# Build a fast lookup by name
_TOOL_MAP: Dict[str, Dict[str, Any]] = {t['name']: t for t in _TOOLS}


class IInstance(IInstanceBase):
    """RocketRide tool node that exposes git operations to an AI agent via pygit2."""

    IGlobal: IGlobal

    # ------------------------------------------------------------------
    # Argument helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _bool_arg(a: Dict[str, Any], key: str, default: bool = False) -> bool:
        """Extract a boolean arg; raise ValueError if the value is not a bool."""
        v = a.get(key, default)
        if isinstance(v, bool):
            return v
        # JSON null deserialises to None — treat it the same as an absent key.
        if v is None:
            return default
        raise ValueError(f'{key} must be a boolean')

    @staticmethod
    def _int_arg_in_range(a: Dict[str, Any], key: str, default: int, lo: int, hi: int) -> int:
        """Extract an integer arg clamped to [lo, hi]; raise ValueError if out of range or wrong type."""
        v = a.get(key, default)
        if isinstance(v, bool) or not isinstance(v, int):
            raise ValueError(f'{key} must be an integer between {lo} and {hi}')
        if not lo <= v <= hi:
            raise ValueError(f'{key} must be between {lo} and {hi}')
        return v

    # ------------------------------------------------------------------
    # Engine entry point
    # ------------------------------------------------------------------

    def invoke(self, param: Any) -> Any:  # noqa: ANN401
        """Dispatch tool.query and tool.invoke operations from the pipeline engine."""
        op = getattr(param, 'op', None)

        if op == 'tool.query':
            for tool in _TOOLS:
                param.tools.append(tool)
            return param

        if op == 'tool.invoke':
            tool_name = getattr(param, 'tool_name', None)
            args = getattr(param, 'input', {}) or {}
            if isinstance(args, str):
                try:
                    args = json.loads(args)
                except json.JSONDecodeError as exc:
                    param.output = json.dumps({'error': f'Invalid JSON input: {exc.msg}'})
                    return param
            if not isinstance(args, dict):
                param.output = json.dumps({'error': 'Tool input must be a JSON object'})
                return param
            param.output = self._dispatch(tool_name, args)
            return param

        return param

    # ------------------------------------------------------------------
    # Dispatch
    # ------------------------------------------------------------------

    def _dispatch(self, tool_name: str, args: Dict[str, Any]) -> str:
        """Validate the tool name, call _call(), and return a JSON-encoded result string."""
        if tool_name not in _TOOL_MAP:
            return json.dumps({'error': f'Unknown tool {tool_name!r}'})
        git = self.IGlobal.repo
        if git is None:
            return json.dumps({'error': 'Git node is not initialised. Check node config.'})
        try:
            return json.dumps(self._call(git, tool_name, args), ensure_ascii=False, default=str)
        except (GitError, ValueError) as exc:
            return json.dumps({'error': str(exc)})
        except KeyError as exc:
            return json.dumps({'error': f'Missing required parameter: {exc}'})

    def _call(self, git: Any, name: str, a: Dict[str, Any]) -> Any:  # noqa: ANN401
        """Map a tool name and validated args dict to the corresponding GitRepo method call."""
        if name == 'git.clone':
            return git.clone(url=a['url'], path=a['path'], branch=a.get('branch') or None)
        if name == 'git.init':
            return git.init(path=a['path'], initial_branch=a.get('initial_branch') or 'main')
        if name == 'git.status':
            return git.status()
        if name == 'git.log':
            return git.log(
                max_count=self._int_arg_in_range(a, 'max_count', 20, 1, 200),
                branch=a.get('branch') or None,
                path=a.get('path') or None,
                author=a.get('author') or None,
                since=a.get('since') or None,
                until=a.get('until') or None,
            )
        if name == 'git.show':
            return git.show(ref=a['ref'])
        if name == 'git.diff':
            ref_a = a.get('ref_a') or None
            ref_b = a.get('ref_b') or None
            if ref_b and not ref_a:
                raise ValueError('ref_b requires ref_a to be set')
            return git.diff(
                ref_a=ref_a,
                ref_b=ref_b,
                path=a.get('path') or None,
                staged=self._bool_arg(a, 'staged', False),
            )
        if name == 'git.blame':
            return git.blame(path=a['path'], ref=a.get('ref') or None)
        if name == 'git.file_at':
            return git.file_at(path=a['path'], ref=a['ref'])
        if name == 'git.write_file':
            return git.write_file(path=a['path'], content=a['content'])
        if name == 'git.stage':
            paths = a.get('paths')
            if (
                not isinstance(paths, list)
                or not paths
                or any(not isinstance(p, str) or not p for p in paths)
            ):
                raise ValueError('paths must be a non-empty list of non-empty strings')
            return git.stage(paths=paths)
        if name == 'git.commit':
            return git.commit(
                message=a['message'],
                author_name=a.get('author_name') or '',
                author_email=a.get('author_email') or '',
            )
        if name == 'git.stash':
            return git.stash(op=a.get('op') or 'push', message=a.get('message') or '', index=a.get('index', 0))
        if name == 'git.branch_list':
            return git.branch_list(
                remote=self._bool_arg(a, 'remote', False),
                all_branches=self._bool_arg(a, 'all_branches', False),
            )
        if name == 'git.branch_create':
            return git.branch_create(name=a['name'], from_ref=a.get('from_ref') or None)
        if name == 'git.checkout':
            return git.checkout(branch=a['branch'])
        if name == 'git.branch_delete':
            return git.branch_delete(name=a['name'], force=self._bool_arg(a, 'force', False))
        if name == 'git.merge':
            return git.merge(branch=a['branch'])
        if name == 'git.fetch':
            return git.fetch(remote=a.get('remote') or 'origin', branch=a.get('branch') or None)
        if name == 'git.pull':
            return git.pull(remote=a.get('remote') or 'origin', branch=a.get('branch') or None)
        if name == 'git.push':
            return git.push(
                remote=a.get('remote') or 'origin',
                branch=a.get('branch') or None,
                force=self._bool_arg(a, 'force', False),
            )
        if name == 'git.grep':
            return git.grep(
                pattern=a['pattern'],
                ref=a.get('ref') or None,
                path=a.get('path') or None,
                ignore_case=self._bool_arg(a, 'ignore_case', False),
            )
        if name == 'git.ls_files':
            return git.ls_files(path=a.get('path') or None, untracked=self._bool_arg(a, 'untracked', False))
        raise ValueError(f'Unhandled tool {name!r}')
