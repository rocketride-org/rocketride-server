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

"""Input validation and result shaping for repository reads."""

import re

from ai.common.utils import int_arg, optional_int

from . import github_client

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
