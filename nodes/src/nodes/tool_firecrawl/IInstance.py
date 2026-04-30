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

Exposes ``scrape_url`` and ``map_url`` tools for web scraping via Firecrawl.
"""

from __future__ import annotations

import json

from rocketlib import IInstanceBase, tool_function, warning

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
                'format': {'type': 'string', 'enum': ['markdown', 'html'], 'description': 'Output format (default: "markdown").', 'default': 'markdown'},
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
        args = _normalize_tool_input(args)
        url = args.get('url')
        if not url:
            raise ValueError('scrape_url requires a `url` parameter')

        result = firecrawl_wrapper(lambda: self.IGlobal.app.scrape(url))

        fmt = args.get('format', 'markdown')
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
        args = _normalize_tool_input(args)
        url = args.get('url')
        if not url:
            raise ValueError('map_url requires a `url` parameter')

        result = firecrawl_wrapper(lambda: self.IGlobal.app.map(url))

        links = []
        if hasattr(result, 'links') and result.links:
            for link in result.links:
                if hasattr(link, 'url'):
                    links.append(link.url)
                elif isinstance(link, str):
                    links.append(link)

        return {'success': True, 'links': links}


def _normalize_tool_input(input_obj):
    """Normalize tool input into a plain dict.

    Handles: None, dict, Pydantic model, JSON string, and nested
    ``input`` wrappers that some framework paths produce.
    """
    if input_obj is None:
        return {}
    if hasattr(input_obj, 'model_dump') and callable(getattr(input_obj, 'model_dump')):
        input_obj = input_obj.model_dump()
    elif hasattr(input_obj, 'dict') and callable(getattr(input_obj, 'dict')):
        input_obj = input_obj.dict()
    if isinstance(input_obj, str):
        try:
            parsed = json.loads(input_obj)
            if isinstance(parsed, dict):
                input_obj = parsed
        except (json.JSONDecodeError, TypeError) as e:
            warning(f'firecrawl: failed to parse input as JSON: {e}')
            pass
    if not isinstance(input_obj, dict):
        warning(f'firecrawl: unexpected input type {type(input_obj).__name__}')
        return {}
    if 'input' in input_obj and isinstance(input_obj['input'], dict):
        inner = input_obj['input']
        extras = {k: v for k, v in input_obj.items() if k != 'input'}
        input_obj = {**inner, **extras}
    input_obj.pop('security_context', None)
    return input_obj
