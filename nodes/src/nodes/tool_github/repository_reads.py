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


def page_params(args: dict, tool_name: str) -> dict:
    """Read ``page`` (an integer of at least 1) and clamp ``per_page`` to 1..100.

    Both must be JSON integers when given: a numeric string, a boolean or a float is
    refused, as ``int_arg`` refuses them for ``per_page``.
    """
    if isinstance(args.get('page'), str):
        raise ValueError(f'{tool_name}: "page" must be an integer >= 1')
    return {
        'page': optional_int(args, 'page', default=1, lo=1, tool_name=tool_name),
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


def repo_tree(read, repo: str, args: dict) -> dict:
    """Read a recursive tree sorted by path, optionally completing a truncated one from subtrees.

    ``ref`` defaults to ``HEAD``, the default branch. The first response's ``sha`` is the
    SHA the ref resolved to (the commit SHA for a branch or tag); every walk request uses
    it or a subtree SHA, so a branch moving during the walk cannot mix revisions.
    ``truncated`` keeps GitHub's flag for the first response; ``complete`` says whether
    every path came back. A bounded walk never claims completeness after a stop.
    """
    path = repository_path(repo, 'repo_tree')
    ref = (optional_str(args, 'ref', default='', tool_name='repo_tree') or '').strip() or 'HEAD'
    walk = optional_bool(args, 'walk', default=False, tool_name='repo_tree')
    max_requests = optional_int(
        args, 'max_requests', default=MAX_REQUESTS_DEFAULT, lo=1, hi=MAX_REQUESTS_LIMIT, tool_name='repo_tree'
    )
    max_entries = optional_int(
        args, 'max_entries', default=MAX_ENTRIES_DEFAULT, lo=1, hi=MAX_ENTRIES_LIMIT, tool_name='repo_tree'
    )

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
    _walk(read, path, raw['sha'], max_requests, max_entries, result)
    return result


class _WalkStopped(Exception):
    """Ends the subtree walk early; the entries listed so far are still returned."""


def _walk(read, path: str, root_sha: str, max_requests: int, max_entries: int, result: dict) -> None:
    """Complete a truncated listing from subtree reads pinned to immutable SHAs.

    Each subtree is read recursively first, which covers most of a repository in one
    request per top-level directory; only a subtree GitHub truncates again is split
    into its direct children. Identical SHAs are read once and expanded at each path,
    so the entry cap, not the request budget, bounds the output when a few trees are
    referenced from thousands of paths (a "git bomb"). A walk that stops early keeps
    the entries GitHub's truncated listing already named, which describe the same
    root SHA, so ``walk: true`` never returns less than ``walk: false`` would.
    """
    initial = result['data']['tree']
    entries: list[dict] = []
    pending = [('', root_sha, False)]  # (path prefix, tree or commit SHA, try a recursive read first)
    cache: dict[str, tuple[list, bool]] = {}
    requests_used = 0

    def fetch(prefix: str, sha: str, recursive: bool) -> dict:
        nonlocal requests_used
        if requests_used >= max_requests:
            waiting = len(pending) + 1
            raise _WalkStopped(
                f'Tree walk reached max_requests ({max_requests}) with {waiting} '
                f'subtree{"" if waiting == 1 else "s"} still pending; raise it (up to {MAX_REQUESTS_LIMIT}) '
                f'or call repo_tree with a subtree sha as ref ({SUBTREE_PATHS}).'
            )
        subtree = read(f'{path}/git/trees/{quote(sha, safe="")}', params={'recursive': '1'} if recursive else None)
        requests_used += 1
        if subtree['status'] is not None:
            # A failure before any HTTP response carries no counters; keep the last known ones.
            result['rate_limit'] = subtree['rate_limit']
        if 'data' in subtree and not _is_tree(subtree['data']):
            subtree = github_client.shape_failure(subtree, 'a tree object')
        if 'data' not in subtree:
            # Keep the failure's status and details, but say the data is partial, not absent.
            status = subtree['status']
            result['status'] = status
            result['documentation_url'] = subtree.get('documentation_url')
            reason = subtree['message'].rstrip('.')
            if status is not None and not 200 <= status < 300:
                reason = f'GitHub API {status}: {reason}'
            plural = '' if requests_used == 1 else 's'
            raise _WalkStopped(
                f'Tree walk stopped at "{prefix or "/"}" after {requests_used} request{plural}: {reason}; '
                'data is partial.'
            )
        return subtree['data']

    try:
        while pending:
            prefix, sha, try_recursive = pending.pop()
            listing = cache.get(sha)
            if listing is None:
                data = fetch(prefix, sha, recursive=True) if try_recursive else None
                if data is None or data.get('truncated'):
                    # Too big for one recursive read: list the direct children and descend.
                    data = fetch(prefix, sha, recursive=False)
                    if data.get('truncated'):
                        raise _WalkStopped(
                            f'GitHub truncated the non-recursive listing of "{prefix or "/"}"; the walk is incomplete.'
                        )
                    listing = (data['tree'], True)
                else:
                    listing = (data['tree'], False)
                cache[sha] = listing
            children, descend = listing
            for entry in children:
                if not _is_entry(entry):
                    continue
                if len(entries) >= max_entries:
                    raise _WalkStopped(
                        f'Tree walk reached max_entries ({max_entries}); raise it (up to {MAX_ENTRIES_LIMIT}) '
                        f'or call repo_tree with a subtree sha as ref ({SUBTREE_PATHS}).'
                    )
                full_path = f'{prefix}/{entry["path"]}' if prefix else entry['path']
                entries.append({**_entry(entry), 'path': full_path})
                if descend and entry.get('type') == 'tree' and isinstance(entry.get('sha'), str):
                    pending.append((full_path, entry['sha'], True))
    except _WalkStopped as stop:
        result['message'] = str(stop)
        # Both listings describe the same root SHA, so merging by path cannot mix revisions.
        merged = {entry['path']: entry for entry in initial}
        merged.update((entry['path'], entry) for entry in entries)
        entries = list(merged.values())
    else:
        result['data']['complete'] = True

    result['data']['tree'] = sorted(entries, key=_path)
    result['data']['walked'] = True


def _is_tree(value) -> bool:
    return isinstance(value, dict) and isinstance(value.get('sha'), str) and isinstance(value.get('tree'), list)


def _is_entry(value) -> bool:
    return isinstance(value, dict) and isinstance(value.get('path'), str)


def _path(entry: dict) -> str:
    return entry['path']


def _entry(entry: dict) -> dict:
    """Keep tree identity and type, including modes for symlinks and submodules."""
    return {key: entry[key] for key in ('path', 'type', 'size', 'sha', 'mode') if key in entry}
