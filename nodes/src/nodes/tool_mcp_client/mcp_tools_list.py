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
cursor, or more than ``MAX_TOOLS_LIST_PAGES`` pages or ``MAX_TOOLS_LIST_ENTRIES``
raw entries raises ``error_cls`` naming the page, instead of returning what was
collected, so a partial list never replaces a good cached catalog
(``IGlobal.refresh_tools`` keeps the old catalog when ``list_tools`` raises).
Entries are counted as the server sent them, before the transport skips
malformed ones and before duplicate names collapse, so a hostile server cannot
dodge the bound with junk. Exceptions raised by the transport itself (timeouts,
HTTP errors, JSON-RPC errors) propagate unchanged with their own diagnostics.
"""

from __future__ import annotations

from typing import Any, Callable, Dict, List, Optional, Type

# Counts of requests and raw entries, not seconds or bytes: how long one page may
# take is up to the transport.
MAX_TOOLS_LIST_PAGES = 100
MAX_TOOLS_LIST_ENTRIES = 5000


def fetch_all_tool_entries(
    request: Callable[[str, Any], Any],
    *,
    error_cls: Type[Exception] = RuntimeError,
    max_pages: int = MAX_TOOLS_LIST_PAGES,
    max_entries: int = MAX_TOOLS_LIST_ENTRIES,
) -> List[Any]:
    """Return the raw ``tools`` entries of every ``tools/list`` page, in server order.

    ``request(method, params)`` is the transport's JSON-RPC call. The first page is
    requested with ``{}`` exactly as before; later pages send ``{'cursor': <value>}``
    with the cursor forwarded untouched (``''`` included). A missing or ``null``
    ``nextCursor`` ends the traversal. A non-string cursor, a cursor seen before, a
    malformed page or an exceeded limit raises ``error_cls`` with the page number in
    the message (cursor values are opaque and are not logged). Exceptions raised by
    ``request`` propagate unchanged.
    """
    entries: List[Any] = []
    seen_cursors: set = set()
    cursor: Optional[str] = None
    for page in range(1, max_pages + 1):
        params: Dict[str, Any] = {} if cursor is None else {'cursor': cursor}
        result = request('tools/list', params)
        if not isinstance(result, dict):
            raise error_cls(f'tools/list page {page} result expected object, got {type(result)}')
        tools = result.get('tools', [])
        if not isinstance(tools, list):
            raise error_cls(f'tools/list page {page} result.tools expected list, got {type(tools)}')
        entries.extend(tools)
        if len(entries) > max_entries:
            raise error_cls(
                f'tools/list returned more than {max_entries} tool entries by page {page}; refusing the catalog'
            )
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
