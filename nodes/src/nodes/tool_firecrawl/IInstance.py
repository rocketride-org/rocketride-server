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
Firecrawl tool node instance.

Exposes ``scrape_url``, ``map_url``, and ``search_web`` tools for web scraping and search via Firecrawl.
"""

from __future__ import annotations

import json

from rocketlib import IInstanceBase, tool_function, warning

from ai.common.utils import normalize_tool_input

from .utils import firecrawl_wrapper
from .IGlobal import IGlobal


class IInstance(IInstanceBase):
    IGlobal: IGlobal

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['url'],
            'properties': {
                'url': {'type': 'string', 'description': 'The URL of the web page to scrape.'},
                'format': {
                    'type': 'string',
                    'enum': ['markdown', 'html'],
                    'description': 'Output format (default: "markdown").',
                    'default': 'markdown',
                },
            },
        },
        output_schema={
            'type': 'object',
            'properties': {
                'success': {'type': 'boolean'},
                'content': {'type': 'string'},
                'metadata': {'type': 'object'},
            },
        },
        description='Scrape a single web page and return its content.',
    )
    def scrape_url(self, args):
        """Scrape a single web page."""
        args = normalize_tool_input(args, tool_name='firecrawl')
        url = args.get('url')
        if not url:
            raise ValueError('scrape_url requires a `url` parameter')

        fmt = args.get('format', 'markdown')
        if fmt not in ('markdown', 'html'):
            fmt = 'markdown'

        result = firecrawl_wrapper(lambda: self.IGlobal.app.scrape(url, formats=[fmt], integration='_rocketride'))

        content = getattr(result, fmt, None) or getattr(result, 'markdown', None) or ''
        if not isinstance(content, str):
            content = json.dumps(content)

        metadata = getattr(result, 'metadata', None)
        if metadata is not None and not isinstance(metadata, dict):
            try:
                metadata = metadata.model_dump(exclude_none=True) if hasattr(metadata, 'model_dump') else {}
            except Exception as e:
                warning(f'firecrawl: failed to dump metadata: {e}')
                metadata = {}

        return {'success': True, 'content': content, 'metadata': metadata or {}}

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['url'],
            'properties': {
                'url': {'type': 'string', 'description': 'The root URL of the website to map.'},
            },
        },
        output_schema={
            'type': 'object',
            'properties': {
                'success': {'type': 'boolean'},
                'links': {'type': 'array', 'items': {'type': 'string'}},
            },
        },
        description="Map a website's structure and return all discovered URLs.",
    )
    def map_url(self, args):
        """Map a website's URL structure."""
        args = normalize_tool_input(args, tool_name='firecrawl')
        url = args.get('url')
        if not url:
            raise ValueError('map_url requires a `url` parameter')

        result = firecrawl_wrapper(lambda: self.IGlobal.app.map(url, integration='_rocketride'))

        links = []
        if hasattr(result, 'links') and result.links:
            for link in result.links:
                if hasattr(link, 'url'):
                    links.append(link.url)
                elif isinstance(link, str):
                    links.append(link)

        return {'success': True, 'links': links}

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['query'],
            'properties': {
                'query': {'type': 'string', 'description': 'The search query.'},
                'limit': {
                    'type': 'integer',
                    'description': 'Maximum number of results to return (1-20). Defaults to the node config value.',
                },
                'scrape_markdown': {
                    'type': 'boolean',
                    'description': 'Whether to scrape each result page and include its markdown content (default: false).',
                    'default': False,
                },
            },
        },
        output_schema={
            'type': 'object',
            'properties': {
                'success': {'type': 'boolean'},
                'results': {'type': 'array', 'items': {'type': 'object'}},
            },
        },
        description='Search the web and return matching results.',
    )
    def search_web(self, args):
        """Search the web using Firecrawl."""
        args = normalize_tool_input(args, tool_name='firecrawl')
        raw_query = args.get('query')
        query = raw_query.strip() if isinstance(raw_query, str) else ''
        if not query:
            raise ValueError('search_web requires a `query` parameter')

        default_max = getattr(self.IGlobal, 'max_results', 5)
        raw_limit = args.get('limit', default_max)
        if raw_limit is None or isinstance(raw_limit, bool):
            limit = default_max
        else:
            try:
                limit = int(raw_limit)
            except (ValueError, TypeError):
                limit = default_max
        limit = max(1, min(20, limit))

        scrape_markdown = bool(args.get('scrape_markdown', False))
        search_kwargs: dict = {'limit': limit, 'integration': '_rocketride'}
        if scrape_markdown:
            search_kwargs['scrape_options'] = {'formats': ['markdown']}

        result = firecrawl_wrapper(lambda: self.IGlobal.app.search(query, **search_kwargs))

        raw_items = (
            getattr(result, 'web', None)
            or getattr(result, 'data', None)
            or (result.get('web') or result.get('data') if isinstance(result, dict) else None)
            or (result if isinstance(result, list) else [])
        )

        results = []
        for item in raw_items or []:
            if isinstance(item, dict):
                entry = {
                    'url': item.get('url', '') or '',
                    'title': item.get('title', '') or '',
                    'description': item.get('description', '') or '',
                }
                markdown = item.get('markdown')
            else:
                entry = {
                    'url': getattr(item, 'url', '') or '',
                    'title': getattr(item, 'title', '') or '',
                    'description': getattr(item, 'description', '') or '',
                }
                markdown = getattr(item, 'markdown', None)

            if scrape_markdown or markdown:
                entry['markdown'] = markdown or ''
            results.append(entry)

        return {'success': True, 'results': results}
