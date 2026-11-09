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
Shared ``tools/list`` traversal for the MCP client transports.

MCP paginates ``tools/list`` with an opaque ``nextCursor``; the server picks the
page size and a client must not assume one. Each transport hands its
``_request`` method to ``fetch_all_tool_entries``, which follows the cursor
until the server omits it, and returns the raw entries of every page in order.

Cursors are opaque strings and are forwarded byte for byte, the empty string
included. Only a missing ``nextCursor`` (or JSON ``null``, which cannot be
forwarded) ends the traversal.

The traversal is complete-or-raise: a malformed page, a non-string or repeated
cursor, a tool name already listed on an earlier page, more than
``MAX_TOOLS_LIST_PAGES`` pages or ``MAX_TOOLS_LIST_ENTRIES`` raw entries, or a
traversal still unfinished after ``MAX_TOOLS_LIST_SECONDS`` raises ``error_cls``
naming the page, instead of returning what was collected, so a partial list
never replaces a good cached catalog (``IGlobal.refresh_tools`` keeps the old
catalog when ``list_tools`` raises). Entries are counted as the server sent
them, before the transport skips malformed ones, so a hostile server cannot
dodge the bound with junk. A name repeated within one page is left to the caller
as before. Exceptions raised by the transport itself (timeouts, HTTP errors,
JSON-RPC errors) propagate unchanged with their own diagnostics.
"""

from __future__ import annotations

import time
from typing import Any, Callable, Dict, List, Optional, Type

MAX_TOOLS_LIST_PAGES = 100
MAX_TOOLS_LIST_ENTRIES = 5000
# Checked before each request after the first. A request already in flight is
# not cut short: how long one request may take is up to the transport, as before.
MAX_TOOLS_LIST_SECONDS = 60.0


def _monotonic() -> float:
    """Clock for the time budget; tests drive this instead of patching ``time.monotonic``."""
    return time.monotonic()


def fetch_all_tool_entries(
    request: Callable[[str, Any], Any],
    *,
    error_cls: Type[Exception] = RuntimeError,
    max_pages: int = MAX_TOOLS_LIST_PAGES,
    max_entries: int = MAX_TOOLS_LIST_ENTRIES,
    max_seconds: float = MAX_TOOLS_LIST_SECONDS,
) -> List[Any]:
    """Return the raw ``tools`` entries of every ``tools/list`` page, in server order.

    ``request(method, params)`` is the transport's JSON-RPC call. The first page is
    requested with ``{}`` exactly as before; later pages send ``{'cursor': <value>}``
    with the cursor forwarded untouched (``''`` included). A missing or ``null``
    ``nextCursor`` ends the traversal. A non-string cursor, a cursor seen before, a
    tool name listed on an earlier page, a malformed page or an exceeded limit raises
    ``error_cls`` with the page number in the message (cursor values are opaque and
    are not logged). Exceptions raised by ``request`` propagate unchanged.
    """
    entries: List[Any] = []
    seen_cursors: set = set()
    seen_names: set = set()
    cursor: Optional[str] = None
    deadline = _monotonic() + max_seconds
    for page in range(1, max_pages + 1):
        if page > 1 and _monotonic() >= deadline:
            raise error_cls(
                f'tools/list ran past its {max_seconds:g} s budget before page {page}; refusing the catalog'
            )
        params: Dict[str, Any] = {} if cursor is None else {'cursor': cursor}
        result = request('tools/list', params)
        if not isinstance(result, dict):
            raise error_cls(f'tools/list page {page} result expected object, got {type(result)}')
        tools = result.get('tools', [])
        if not isinstance(tools, list):
            raise error_cls(f'tools/list page {page} result.tools expected list, got {type(tools)}')
        if len(entries) + len(tools) > max_entries:
            raise error_cls(
                f'tools/list returned more than {max_entries} tool entries by page {page}; refusing the catalog'
            )
        page_names = {t['name'] for t in tools if isinstance(t, dict) and isinstance(t.get('name'), str) and t['name']}
        repeated = page_names & seen_names
        if repeated:
            name = min(repeated)
            raise error_cls(
                f'tools/list page {page} lists tool {name[:100]!r} again from an earlier page; refusing the catalog'
            )
        seen_names |= page_names
        entries.extend(tools)
        next_cursor = result.get('nextCursor')
        if next_cursor is None:
            return entries
        if not isinstance(next_cursor, str):
            raise error_cls(f'tools/list page {page} nextCursor expected string, got {type(next_cursor)}')
        if next_cursor in seen_cursors:
            raise error_cls(f'tools/list page {page} repeated an earlier cursor; refusing the catalog')
        seen_cursors.add(next_cursor)
        cursor = next_cursor
    raise error_cls(f'tools/list did not finish within {max_pages} pages; refusing the catalog')
