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

"""Input validation, result shaping and the snapshot-pinned tree walk for repository reads."""

import re
from urllib.parse import quote

from ai.common.utils import int_arg, optional_bool, optional_int, optional_str

from . import github_client

# A walk reads each subtree recursively first and splits only the ones GitHub truncates
# again, so a repository the size of Linux takes tens of requests, not one per directory.
MAX_REQUESTS_DEFAULT = 1000
MAX_REQUESTS_LIMIT = 10000
# Identical subtree SHAs are read once and expanded at every path, so a few trees
# referenced from thousands of paths (a git bomb) multiply entries while requests stay
# few: the entry cap, not the request budget, bounds that.
MAX_ENTRIES_DEFAULT = 200_000
MAX_ENTRIES_LIMIT = 1_000_000
# Said wherever a stop message advises reading a subtree by its SHA.
SUBTREE_PATHS = 'its paths are then relative to that subtree'

_REPO_RE = re.compile(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+')


def repository_path(repo: str, tool_name: str = '') -> str:
    """Validate a repository identifier before it becomes part of an API path.

    ``repo`` is a string already: ``IInstance._repo`` checks the type and names the tool.
    """
    prefix = f'{tool_name}: ' if tool_name else ''
    if not _REPO_RE.fullmatch(repo):
        raise ValueError(f'{prefix}repo must be in owner/repo format')
    if any(part in ('.', '..') for part in repo.split('/')):
        raise ValueError(f'{prefix}repo must be in owner/repo format')
    return f'/repos/{repo}'


def json_int(args: dict, key: str, *, default: int, lo: int, hi: int | None = None, tool_name: str) -> int:
    """An optional integer option within bounds, as the JSON integer it must be.

    ``optional_int`` already refuses a boolean and a float; this also refuses a numeric
    string, so every integer option of the node reads the same way.
    """
    if isinstance(args.get(key), str):
        bounds = f'between {lo} and {hi}' if hi is not None else f'>= {lo}'
        raise ValueError(f'{tool_name}: "{key}" must be an integer {bounds}')
    return optional_int(args, key, default=default, lo=lo, hi=hi, tool_name=tool_name)


def page_params(args: dict, tool_name: str) -> dict:
    """Read ``page`` (an integer of at least 1) and clamp ``per_page`` to 1..100.

    Both must be JSON integers when given: a numeric string, a boolean or a float is
    refused, as ``int_arg`` refuses them for ``per_page``.
    """
    return {
        'page': json_int(args, 'page', default=1, lo=1, tool_name=tool_name),
        'per_page': int_arg(args, 'per_page', default=30, lo=1, hi=100, tool_name=tool_name),
    }


def pick_items(result: dict, keys: tuple[str, ...]) -> dict:
    """Reduce a list result to the given keys; a 204 No Content answer is an empty list."""
    if 'data' not in result:
        return result
    items = [] if result['status'] == 204 else result['data']
    if not isinstance(items, list):
        return github_client.shape_failure(result, 'a list')
    result['data'] = [{key: item.get(key) for key in keys} for item in items if isinstance(item, dict)]
    return result


def expect_object(result: dict) -> dict:
    """Require a JSON object body; anything else becomes a failure result."""
    if 'data' in result and not isinstance(result['data'], dict):
        return github_client.shape_failure(result, 'an object')
    return result


def tree_options(args: dict) -> dict:
    """The typed ``repo_tree`` options: ``ref`` (``HEAD`` by default), ``walk`` and the two bounds."""
    return {
        'ref': (optional_str(args, 'ref', default='', tool_name='repo_tree') or '').strip() or 'HEAD',
        'walk': optional_bool(args, 'walk', default=False, tool_name='repo_tree'),
        'max_requests': json_int(
            args, 'max_requests', default=MAX_REQUESTS_DEFAULT, lo=1, hi=MAX_REQUESTS_LIMIT, tool_name='repo_tree'
        ),
        'max_entries': json_int(
            args, 'max_entries', default=MAX_ENTRIES_DEFAULT, lo=1, hi=MAX_ENTRIES_LIMIT, tool_name='repo_tree'
        ),
    }


def repo_tree(read, repo: str, *, ref: str, walk: bool, max_requests: int, max_entries: int) -> dict:
    """Read a recursive tree sorted by path, optionally completing a truncated one from subtrees.

    ``ref`` is the branch, tag or SHA to read (``HEAD`` is the default branch). The first
    response's ``sha`` is the SHA the ref resolved to (the commit SHA for a branch or tag);
    every walk request uses it or a subtree SHA, so a branch moving during the walk cannot
    mix revisions. ``truncated`` keeps GitHub's flag for the first response; ``complete``
    says whether every path came back. A bounded walk never claims completeness after a
    stop. The options come typed from ``tree_options``.
    """
    path = repository_path(repo, 'repo_tree')
    result = read(f'{path}/git/trees/{quote(ref, safe="")}', params={'recursive': '1'})
    if 'data' not in result:
        return result
    raw = result['data']
    if not _is_tree(raw):
        return github_client.shape_failure(result, 'a tree object')
    truncated = bool(raw.get('truncated'))
    listed = {entry['path']: _entry(entry) for entry in raw['tree'] if _is_entry(entry)}
    result['data'] = {
        'sha': raw['sha'],
        'tree': sorted(listed.values(), key=_path),
        'truncated': truncated,
        'complete': not truncated,
        'walked': False,
    }
    if not truncated:
        return result
    if not walk:
        result['message'] = 'GitHub truncated the recursive listing; set walk: true to complete it from subtrees.'
        return result
    _TreeWalk(read, path, raw['sha'], max_requests, max_entries, result).run()
    return result


class _TreeWalk:
    """Completes a truncated listing from subtree reads pinned to immutable SHAs.

    Each subtree is read recursively first, which covers most of a repository in one
    request per top-level directory; only a subtree GitHub truncates again is split
    into its direct children. Identical SHAs are read once and expanded at each path,
    so the entry cap, not the request budget, bounds the output when a few trees are
    referenced from thousands of paths (a "git bomb"). A walk that stops early keeps
    the entries GitHub's truncated listing already named, which describe the same
    root SHA, so ``walk: true`` never returns less than ``walk: false`` would.

    ``run`` drives the walk; ``_listing``, ``_read`` and ``_expand`` each return the
    stop reason (a message) instead of a value when the walk must end, and ``_stop``
    merges what was listed with the initial listing.
    """

    def __init__(self, read, path: str, root_sha: str, max_requests: int, max_entries: int, result: dict) -> None:
        self._read_result = read
        self._path = path
        self._max_requests = max_requests
        self._max_entries = max_entries
        self._result = result
        self._initial = result['data']['tree']
        self._entries: list[dict] = []
        # (path prefix, tree or commit SHA, try a recursive read first); the root was
        # already read recursively and truncated, so it goes straight to its children.
        self._pending = [('', root_sha, False)]
        self._cache: dict[str, tuple[list, bool]] = {}
        self._requests_used = 0

    def run(self) -> None:
        """Walk every pending subtree; on an early stop keep the initial listing's entries."""
        stop = self._walk()
        if stop is None:
            self._result['data']['complete'] = True
            entries = self._entries
        else:
            entries = self._stop(stop)
        self._result['data']['tree'] = sorted(entries, key=_path)
        self._result['data']['walked'] = True

    def _walk(self) -> str | None:
        """Loop over the pending subtrees; the stop reason, or ``None`` when every path came back."""
        while self._pending:
            prefix, sha, try_recursive = self._pending.pop()
            listing = self._cache.get(sha)
            if listing is None:
                listing = self._listing(prefix, sha, try_recursive)
                if isinstance(listing, str):
                    return listing
                self._cache[sha] = listing
            stop = self._expand(prefix, *listing)
            if stop is not None:
                return stop
        return None

    def _listing(self, prefix: str, sha: str, try_recursive: bool) -> tuple[list, bool] | str:
        """A subtree's entries and whether to descend into them, or the stop reason.

        One recursive read when it fits; otherwise the direct children, which are
        descended into one by one.
        """
        if try_recursive:
            data = self._read(prefix, sha, recursive=True)
            if isinstance(data, str):
                return data
            if not data.get('truncated'):
                return (data['tree'], False)
        data = self._read(prefix, sha, recursive=False)
        if isinstance(data, str):
            return data
        if data.get('truncated'):
            return f'GitHub truncated the non-recursive listing of "{prefix or "/"}"; the walk is incomplete.'
        return (data['tree'], True)

    def _read(self, prefix: str, sha: str, recursive: bool) -> dict | str:
        """One subtree read within the request budget: the tree object, or the stop reason.

        The result keeps the last counters GitHub sent and, after a failed read, that
        read's status and details.
        """
        if self._requests_used >= self._max_requests:
            waiting = len(self._pending) + 1
            return (
                f'Tree walk reached max_requests ({self._max_requests}) with {waiting} '
                f'subtree{"" if waiting == 1 else "s"} still pending; raise it (up to {MAX_REQUESTS_LIMIT}) '
                f'or call repo_tree with a subtree sha as ref ({SUBTREE_PATHS}).'
            )
        subtree = self._read_result(
            f'{self._path}/git/trees/{quote(sha, safe="")}', params={'recursive': '1'} if recursive else None
        )
        self._requests_used += 1
        if subtree['status'] is not None:
            # A failure before any HTTP response carries no counters; keep the last known ones.
            self._result['rate_limit'] = subtree['rate_limit']
        if 'data' in subtree and not _is_tree(subtree['data']):
            subtree = github_client.shape_failure(subtree, 'a tree object')
        if 'data' not in subtree:
            # Keep the failure's status and details, but say the data is partial, not absent.
            status = subtree['status']
            self._result['status'] = status
            self._result['documentation_url'] = subtree.get('documentation_url')
            if 'retry_after' in subtree:
                # A rate limit stopped the walk: keep the wait the next attempt needs.
                self._result['retry_after'] = subtree['retry_after']
            reason = subtree['message'].rstrip('.')
            if status is not None and not 200 <= status < 300:
                reason = f'GitHub API {status}: {reason}'
            plural = '' if self._requests_used == 1 else 's'
            return (
                f'Tree walk stopped at "{prefix or "/"}" after {self._requests_used} request{plural}: {reason}; '
                'data is partial.'
            )
        return subtree['data']

    def _expand(self, prefix: str, children: list, descend: bool) -> str | None:
        """Add a subtree's entries under ``prefix`` within the entry cap, queueing subtrees to descend into."""
        for entry in children:
            if not _is_entry(entry):
                continue
            if len(self._entries) >= self._max_entries:
                return (
                    f'Tree walk reached max_entries ({self._max_entries}); raise it (up to {MAX_ENTRIES_LIMIT}) '
                    f'or call repo_tree with a subtree sha as ref ({SUBTREE_PATHS}).'
                )
            full_path = f'{prefix}/{entry["path"]}' if prefix else entry['path']
            self._entries.append({**_entry(entry), 'path': full_path})
            if descend and entry.get('type') == 'tree' and isinstance(entry.get('sha'), str):
                self._pending.append((full_path, entry['sha'], True))
        return None

    def _stop(self, message: str) -> list[dict]:
        """Record why the walk stopped and merge what it listed with the initial listing."""
        self._result['message'] = message
        # Both listings describe the same root SHA, so merging by path cannot mix revisions.
        merged = {entry['path']: entry for entry in self._initial}
        merged.update((entry['path'], entry) for entry in self._entries)
        return list(merged.values())


def _is_tree(value) -> bool:
    return isinstance(value, dict) and isinstance(value.get('sha'), str) and isinstance(value.get('tree'), list)


def _is_entry(value) -> bool:
    return isinstance(value, dict) and isinstance(value.get('path'), str)


def _path(entry: dict) -> str:
    return entry['path']


def _entry(entry: dict) -> dict:
    """Keep tree identity and type, including modes for symlinks and submodules."""
    return {key: entry[key] for key in ('path', 'type', 'size', 'sha', 'mode') if key in entry}
