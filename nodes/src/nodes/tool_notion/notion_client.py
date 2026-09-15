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

"""Notion API client: auth, headers, retry, error normalization, and the
block-tree-to-plain-text flattening that page content needs.

VERIFIED SURFACE: endpoints and shapes are read directly from
developers.notion.com, not paraphrased. Notably, the 2025-09-03 API version
split what older docs/tutorials call "databases" into two concepts --
``/v1/databases/{id}`` for the container (title, parent, and a `data_sources`
list) and ``/v1/data_sources/{data_source_id}/query`` for querying entries,
replacing the old `/v1/databases/{id}/query`. This client targets that current
shape (``Notion-Version: 2026-03-11``), not the older single-database one a lot
of existing Notion API content still shows.
"""

from __future__ import annotations

import time
from typing import Any, Dict, List, Optional

BASE_URL = 'https://api.notion.com/v1'
NOTION_VERSION = '2026-03-11'
DEFAULT_TIMEOUT = 30


class NotionAPIError(ValueError):
    """Raised when the Notion API returns an error response (or retries are exhausted)."""

    def __init__(self, status_code: int, code: str, message: str):
        super().__init__(f'Notion API {status_code} ({code}): {message}')
        self.status_code = status_code
        self.code = code


def _headers(api_key: str) -> Dict[str, str]:
    return {
        'Authorization': f'Bearer {api_key}',
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json',
    }


def request(
    method: str,
    path: str,
    *,
    api_key: str,
    json_body: Optional[Dict[str, Any]] = None,
    params: Optional[Dict[str, Any]] = None,
    max_retries: int = 3,
    base_delay: float = 2.0,
) -> Dict[str, Any]:
    """Execute one Notion API call, retrying on connection errors, rate limits
    (429), and 5xx. Every failure mode raises ``NotionAPIError`` (never a raw
    ``requests`` exception), so callers only need to catch one type.
    """
    import requests  # lazy

    url = f'{BASE_URL}{path}'
    headers = _headers(api_key)
    for attempt in range(max_retries + 1):
        try:
            resp = requests.request(
                method, url, headers=headers, json=json_body, params=params, timeout=DEFAULT_TIMEOUT
            )
        except requests.exceptions.RequestException as exc:
            if attempt < max_retries:
                time.sleep(base_delay * (2**attempt))
                continue
            raise NotionAPIError(0, 'connection_error', f'{type(exc).__name__}: {exc}') from exc

        if (resp.status_code == 429 or 500 <= resp.status_code < 600) and attempt < max_retries:
            delay = base_delay * (2**attempt)
            # Notion sends Retry-After (seconds) on 429s; honor it when longer
            # than our own backoff rather than hammering a rate limit early.
            retry_after = resp.headers.get('Retry-After')
            if retry_after:
                try:
                    delay = max(delay, float(retry_after))
                except ValueError:
                    pass
            time.sleep(delay)
            continue

        if resp.ok:
            return resp.json() if resp.content else {}

        _raise_for_error(resp)

    raise NotionAPIError(0, 'retry_exhausted', 'Notion API: max retries exceeded')


def _raise_for_error(resp) -> None:
    try:
        body = resp.json()
        code = body.get('code', 'unknown')
        message = body.get('message', resp.text)
    except ValueError:
        code = 'unknown'
        message = resp.text or resp.reason or 'unknown error'
    raise NotionAPIError(resp.status_code, code, message)


# ---------------------------------------------------------------------------
# Database / data source resolution
# ---------------------------------------------------------------------------


def resolve_data_source_id(database_id: str, *, api_key: str, data_source_id: Optional[str] = None) -> str:
    """Return a data_source_id to query.

    A database commonly has exactly one data source (multi-source databases
    are the newer, less common case), so callers can pass just a
    ``database_id`` in the common case; an explicit ``data_source_id``, when
    given, always wins and skips the lookup. Raises when the database has no
    data source, or more than one and the caller didn't disambiguate.
    """
    if data_source_id:
        return data_source_id
    db = request('GET', f'/databases/{database_id}', api_key=api_key)
    sources = db.get('data_sources') or []
    if not sources:
        raise NotionAPIError(0, 'no_data_source', f'database {database_id} has no data sources')
    if len(sources) > 1:
        names = ', '.join(f'{s.get("name")} ({s.get("id")})' for s in sources)
        raise NotionAPIError(
            0,
            'ambiguous_data_source',
            f'database {database_id} has {len(sources)} data sources ({names}); pass data_source_id to disambiguate',
        )
    return sources[0]['id']


def get_title_property_name(data_source_id: str, *, api_key: str) -> str:
    """Return the name of a data source's title property (there is exactly one).

    Property keys are per-database (e.g. a "Task" column instead of "Name"),
    so a page created as a database row must use whichever key the schema
    actually defines, not a guessed default.
    """
    ds = request('GET', f'/data_sources/{data_source_id}', api_key=api_key)
    for name, prop in (ds.get('properties') or {}).items():
        if isinstance(prop, dict) and prop.get('type') == 'title':
            return name
    raise NotionAPIError(0, 'no_title_property', f'data source {data_source_id} has no title property')


# ---------------------------------------------------------------------------
# Block tree -> plain text (page content)
# ---------------------------------------------------------------------------

# Block types whose text lives at block[type]['rich_text']. Types with no text
# (divider, image, table, etc.) are silently skipped rather than guessed at.
_TEXT_BLOCK_TYPES = frozenset(
    {
        'paragraph',
        'heading_1',
        'heading_2',
        'heading_3',
        'bulleted_list_item',
        'numbered_list_item',
        'to_do',
        'toggle',
        'quote',
        'callout',
        'code',
    }
)


def _block_plain_text(block: Dict[str, Any]) -> str:
    """The plain text of one block, or '' for a type with no rich_text."""
    block_type = block.get('type')
    if block_type not in _TEXT_BLOCK_TYPES:
        return ''
    payload = block.get(block_type) or {}
    rich_text = payload.get('rich_text') or []
    return ''.join(item.get('plain_text', '') for item in rich_text if isinstance(item, dict))


def get_page_content(block_id: str, *, api_key: str, max_depth: int = 4, _depth: int = 0) -> str:
    """Fetch and flatten a page's (or block's) children into plain text.

    Notion page content is a block tree, not plain text -- this walks it and
    joins each block's text onto its own line, indenting nested children (e.g.
    a toggle's contents, a nested bullet) up to ``max_depth`` levels. Blocks
    with no text (dividers, images, tables, ...) contribute nothing.
    """
    lines: List[str] = []
    cursor: Optional[str] = None
    while True:
        params: Dict[str, Any] = {'page_size': 100}
        if cursor:
            params['start_cursor'] = cursor
        body = request('GET', f'/blocks/{block_id}/children', api_key=api_key, params=params)

        for block in body.get('results', []):
            text = _block_plain_text(block)
            if text:
                lines.append(('  ' * _depth) + text)
            if block.get('has_children') and _depth < max_depth:
                child_id = block.get('id')
                if child_id:
                    nested = get_page_content(child_id, api_key=api_key, max_depth=max_depth, _depth=_depth + 1)
                    if nested:
                        lines.append(nested)

        cursor = body.get('next_cursor')
        if not body.get('has_more') or not cursor:
            break

    return '\n'.join(lines)


# ---------------------------------------------------------------------------
# Rich-text property helpers (writes)
# ---------------------------------------------------------------------------


def title_property(text: str) -> Dict[str, Any]:
    return {'title': [{'type': 'text', 'text': {'content': text}}]}


# Notion's documented request limits (developers.notion.com/reference/request-limits):
# a rich_text `text.content` string tops out at 2000 characters, and a single
# PATCH /blocks/{id}/children call accepts at most 100 block children.
MAX_RICH_TEXT_LENGTH = 2000
MAX_BLOCKS_PER_APPEND = 100


def paragraph_blocks(text: str) -> List[Dict[str, Any]]:
    """One paragraph block per non-empty line of ``text``.

    Raises ``NotionAPIError`` if any line exceeds Notion's per-rich-text
    character limit -- callers should shorten the line rather than have it
    silently truncated or rejected by the API with a less specific error.
    """
    blocks = []
    for line in text.split('\n'):
        if not line.strip():
            continue
        if len(line) > MAX_RICH_TEXT_LENGTH:
            raise NotionAPIError(
                0,
                'line_too_long',
                f'a line is {len(line)} characters, over Notion’s {MAX_RICH_TEXT_LENGTH}-character rich-text limit',
            )
        blocks.append(
            {
                'object': 'block',
                'type': 'paragraph',
                'paragraph': {'rich_text': [{'type': 'text', 'text': {'content': line}}]},
            }
        )
    return blocks


def append_block_children(block_id: str, blocks: List[Dict[str, Any]], *, api_key: str) -> int:
    """Append ``blocks`` to a page/block's children, batching into Notion's
    100-blocks-per-request limit. Returns the number of blocks appended.

    Each batch is sent with ``max_retries=0``: appending is a non-idempotent
    mutation, so a connection error or 5xx of unknown outcome must not be
    blindly retried and risk appending the same blocks twice.
    """
    appended = 0
    for start in range(0, len(blocks), MAX_BLOCKS_PER_APPEND):
        batch = blocks[start : start + MAX_BLOCKS_PER_APPEND]
        request('PATCH', f'/blocks/{block_id}/children', api_key=api_key, json_body={'children': batch}, max_retries=0)
        appended += len(batch)
    return appended
