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
scraper_beautifulsoup instance.

Tool variant (``scraper_beautifulsoup://``) exposes four agent tools:

* ``fetch_page``  — a page as clean markdown, plain text, raw HTML, or its links;
* ``extract``     — repeated items from a page via CSS selectors;
* ``fetch_feed``  — items from an RSS / Atom feed;
* ``fetch_json``  — a JSON API response, optionally mapped to items.

Every request goes through the guarded fetcher (public hosts only, redirects
re-validated, size cap, pacing, optional allow-list).

Source variant: ``renderObject`` delegates to
:meth:`IEndpoint.renderSourceObject` (the engine's DIRECT pipeline mode).
"""

from __future__ import annotations

import json
from typing import TYPE_CHECKING, Any, Dict, Tuple

from ai.common.utils import int_arg, normalize_tool_input, register_debugger_thread
from rocketlib import IInstanceBase, tool_function

if TYPE_CHECKING:
    # Annotation-only: keeps minimal test stubs of ``rocketlib`` importable.
    from rocketlib import Entry

from .IGlobal import IGlobal
from .scrape_extract import (
    extract_html_items,
    extract_json_items,
    get_path,
    page_links,
    page_to_markdown,
    page_to_text,
    parse_feed,
)
from .scrape_fetch import FetchError
from .scrape_sources import normalize_row

DEFAULT_MAX_CHARS = 20000
MAX_CHARS = 1_000_000
DEFAULT_LIMIT = 50
MAX_ITEMS = 500


def _clip(text: str, max_chars: int) -> Tuple[str, bool]:
    if len(text) <= max_chars:
        return text, False
    return text[:max_chars], True


class IInstance(IInstanceBase):
    IGlobal: IGlobal

    # -- source variant ---------------------------------------------------

    def renderObject(self, object: Entry):
        """Deliver one configured source for the ``scraper_beautifulsoup_source://`` variant.

        The tool variant never receives ``renderObject`` (it is only invoked on
        pipeline-source pipes), but guard anyway so a non-source endpoint falls
        through to the engine default.
        """
        register_debugger_thread('scraper_beautifulsoup')
        render = getattr(self.IEndpoint, 'renderSourceObject', None)
        if render is None:
            return
        render(object, self.instance)
        return self.preventDefault()

    # -- tools --------------------------------------------------------------

    def _fetch(self, url: Any, **kwargs):
        if not isinstance(url, str) or not url.strip():
            raise ValueError('`url` is required')
        fetcher = self.IGlobal.fetcher
        if fetcher is None:
            raise RuntimeError('scraper_beautifulsoup: node is not initialised')
        try:
            return fetcher.fetch(url.strip(), **kwargs)
        except FetchError as e:
            raise ValueError(str(e)) from e

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['url'],
            'properties': {
                'url': {'type': 'string', 'description': 'Absolute http(s) URL of the page.'},
                'format': {
                    'type': 'string',
                    'enum': ['markdown', 'text', 'html', 'links'],
                    'description': 'markdown (default): readable page with links; text: plain text; html: raw HTML; links: list of outgoing links.',
                },
                'selector': {
                    'type': 'string',
                    'description': 'Optional CSS selector for the region to keep (defaults to <main>, <article>, or <body>).',
                },
                'max_chars': {
                    'type': 'integer',
                    'description': 'Maximum characters of content to return (default 20000).',
                },
            },
        },
        output_schema={
            'type': 'object',
            'properties': {
                'url': {'type': 'string'},
                'status': {'type': 'integer'},
                'title': {'type': 'string'},
                'description': {'type': 'string'},
                'content': {'type': 'string'},
                'links': {'type': 'array', 'items': {'type': 'object'}},
                'truncated': {'type': 'boolean'},
            },
        },
        description='Fetch a public web page and return it as markdown, plain text, raw HTML, or its list of links.',
    )
    def fetch_page(self, args):
        args = normalize_tool_input(args, tool_name='scraper')
        fmt = str(args.get('format') or 'markdown').lower()
        if fmt not in ('markdown', 'text', 'html', 'links'):
            raise ValueError('`format` must be markdown, text, html or links')
        max_chars = int_arg(args, 'max_chars', default=DEFAULT_MAX_CHARS, lo=1, hi=MAX_CHARS, tool_name='scraper')
        result = self._fetch(args.get('url'))
        out: Dict[str, Any] = {'url': result.url, 'status': result.status, 'truncated': result.truncated}

        if fmt == 'links':
            out['links'] = page_links(result.content, result.url)
            return out
        if fmt == 'html':
            content, clipped = _clip(result.text(), max_chars)
            out.update(content=content, truncated=result.truncated or clipped)
            return out

        selector = args.get('selector') or None
        view = (
            page_to_text(result.content, selector)
            if fmt == 'text'
            else page_to_markdown(result.content, result.url, selector)
        )
        content, clipped = _clip(view['content'], max_chars)
        out.update(
            title=view['title'] or '',
            description=view['description'] or '',
            content=content,
            truncated=result.truncated or clipped,
        )
        return out

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['url', 'fields'],
            'properties': {
                'url': {'type': 'string', 'description': 'Absolute http(s) URL of the page.'},
                'item_selector': {
                    'type': 'string',
                    'description': 'CSS selector matching each repeated item (e.g. "article.post"). Omit to treat the whole page as one item.',
                },
                'fields': {
                    'type': 'object',
                    'description': 'Map of output field -> "css selector" (element text) or "css selector@attr" (attribute). "@href" alone reads the item element itself. Example: {"title": "h2", "url": "h2 a@href"}.',
                    'additionalProperties': {'type': 'string'},
                },
                'limit': {'type': 'integer', 'description': 'Maximum items to return (default 50).'},
            },
        },
        output_schema={
            'type': 'object',
            'properties': {'url': {'type': 'string'}, 'items': {'type': 'array', 'items': {'type': 'object'}}},
        },
        description='Extract repeated items (listings, search results, link lists) from a web page using CSS selectors.',
    )
    def extract(self, args):
        args = normalize_tool_input(args, tool_name='scraper')
        fields = args.get('fields')
        if not isinstance(fields, dict) or not fields:
            raise ValueError('`fields` must be a non-empty object of name -> selector')
        limit = int_arg(args, 'limit', default=DEFAULT_LIMIT, lo=1, hi=MAX_ITEMS, tool_name='scraper')
        result = self._fetch(args.get('url'))
        items = extract_html_items(result.content, result.url, str(args.get('item_selector') or ''), fields)
        return {'url': result.url, 'items': items[:limit]}

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['url'],
            'properties': {
                'url': {'type': 'string', 'description': 'Absolute http(s) URL of an RSS or Atom feed.'},
                'limit': {'type': 'integer', 'description': 'Maximum items to return (default 50).'},
            },
        },
        output_schema={
            'type': 'object',
            'properties': {'url': {'type': 'string'}, 'items': {'type': 'array', 'items': {'type': 'object'}}},
        },
        description='Read an RSS or Atom feed and return its items (title, url, author, published_at, body).',
    )
    def fetch_feed(self, args):
        args = normalize_tool_input(args, tool_name='scraper')
        limit = int_arg(args, 'limit', default=DEFAULT_LIMIT, lo=1, hi=MAX_ITEMS, tool_name='scraper')
        result = self._fetch(args.get('url'))
        try:
            raw_items = parse_feed(result.content)
        except ValueError as e:
            raise ValueError(f'{result.url}: {e}') from e
        items = []
        for raw in raw_items:
            row = normalize_row(
                raw,
                source=result.url,
                platform='feed',
                base_url=result.url,
                fetched_at='',
                extra={},
                max_body_chars=self.IGlobal.max_body_chars,
            )
            if row:
                items.append({k: row[k] for k in ('title', 'url', 'author', 'published_at', 'body')})
            if len(items) >= limit:
                break
        return {'url': result.url, 'items': items}

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['url'],
            'properties': {
                'url': {'type': 'string', 'description': 'Absolute http(s) URL of a public JSON API.'},
                'method': {'type': 'string', 'enum': ['GET', 'POST'], 'description': 'HTTP method (default GET).'},
                'body_json': {'description': 'JSON body for POST (e.g. a GraphQL {"query": "..."}).'},
                'headers': {'type': 'object', 'additionalProperties': {'type': 'string'}},
                'items_path': {
                    'type': 'string',
                    'description': 'Dot path to the item list, e.g. "hits" or "data.children". Omit to return the raw JSON.',
                },
                'fields': {
                    'type': 'object',
                    'description': 'Map of output field -> dot path inside each item, e.g. {"title": "data.title"}. Used with items_path.',
                    'additionalProperties': {'type': 'string'},
                },
                'limit': {'type': 'integer', 'description': 'Maximum items to return (default 50).'},
                'max_chars': {
                    'type': 'integer',
                    'description': 'Maximum size of the raw JSON returned when items_path is omitted (default 20000).',
                },
            },
        },
        output_schema={
            'type': 'object',
            'properties': {
                'url': {'type': 'string'},
                'items': {'type': 'array', 'items': {'type': 'object'}},
                'data': {},
                'truncated': {'type': 'boolean'},
            },
        },
        description='Call a public JSON API (GET or POST) and return the response, or a list of items mapped by dot paths.',
    )
    def fetch_json(self, args):
        args = normalize_tool_input(args, tool_name='scraper')
        method = str(args.get('method') or 'GET').upper()
        limit = int_arg(args, 'limit', default=DEFAULT_LIMIT, lo=1, hi=MAX_ITEMS, tool_name='scraper')
        max_chars = int_arg(args, 'max_chars', default=DEFAULT_MAX_CHARS, lo=1, hi=MAX_CHARS, tool_name='scraper')
        headers = args.get('headers') if isinstance(args.get('headers'), dict) else {}
        headers = {'Accept': 'application/json', **headers}
        result = self._fetch(args.get('url'), method=method, headers=headers, json_body=args.get('body_json'))
        try:
            data = result.json()
        except ValueError as e:
            raise ValueError(f'{result.url} did not return JSON: {e}') from e

        items_path = args.get('items_path')
        if items_path:
            fields = args.get('fields')
            if isinstance(fields, dict) and fields:
                items = extract_json_items(data, items_path, fields)
            else:
                found = get_path(data, items_path)
                items = found if isinstance(found, list) else ([found] if found is not None else [])
            return {'url': result.url, 'items': items[:limit]}

        text = json.dumps(data)
        if len(text) <= max_chars:
            return {'url': result.url, 'data': data, 'truncated': result.truncated}
        return {'url': result.url, 'data': text[:max_chars], 'truncated': True}
