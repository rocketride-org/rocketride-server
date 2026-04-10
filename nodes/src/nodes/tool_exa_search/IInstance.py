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
Exa Search tool node instance.

Exposes ``exa_search`` as a @tool_function for semantic web search via the Exa API.
"""

from __future__ import annotations

import json
import time
from typing import Any, Dict

import requests

from rocketlib import IInstanceBase, tool_function, warning, debug

from .IGlobal import IGlobal

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

EXA_SEARCH_URL = 'https://api.exa.ai/search'

VALID_SEARCH_TYPES = {'auto', 'neural', 'keyword'}


class IInstance(IInstanceBase):
    IGlobal: IGlobal

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['query'],
            'properties': {
                'query': {
                    'type': 'string',
                    'description': 'The search query. Can be a natural language question or keyword phrase.',
                },
                'num_results': {
                    'type': 'integer',
                    'description': 'Number of results to return (1-50). Defaults to the node config value.',
                },
                'type': {
                    'type': 'string',
                    'enum': sorted(VALID_SEARCH_TYPES),
                    'description': 'Search type: "auto" (default), "neural" (semantic), or "keyword" (traditional).',
                },
                'use_autoprompt': {
                    'type': 'boolean',
                    'description': 'Whether to let Exa optimize the query for better results.',
                },
                'include_domains': {
                    'type': 'array',
                    'items': {'type': 'string'},
                    'description': 'Only return results from these domains (e.g. ["arxiv.org", "github.com"]).',
                },
                'exclude_domains': {
                    'type': 'array',
                    'items': {'type': 'string'},
                    'description': 'Exclude results from these domains.',
                },
                'start_published_date': {
                    'type': 'string',
                    'description': 'Only return results published after this date (ISO 8601, e.g. "2024-01-01").',
                },
                'end_published_date': {
                    'type': 'string',
                    'description': 'Only return results published before this date (ISO 8601, e.g. "2025-12-31").',
                },
                'include_text': {
                    'type': 'boolean',
                    'description': 'Whether to include full text content in results. Defaults to node config value.',
                },
            },
        },
        output_schema={
            'type': 'object',
            'properties': {
                'success': {'type': 'boolean'},
                'query': {'type': 'string'},
                'num_results': {'type': 'integer'},
                'results': {'type': 'array', 'items': {'type': 'object'}},
                'error': {'type': 'string'},
            },
        },
        description='Search the web using Exa semantic search. Provide a natural language query to find relevant web pages. Returns structured results with title, URL, text content, relevance score, and published date.',
        summary='Searches the web using Exa semantic search API',
    )
    def exa_search(self, args):
        """Search the web using Exa semantic search."""
        args = _normalize_tool_input(args)

        query = (args.get('query') or '').strip()
        if not query:
            return {'success': False, 'query': '', 'num_results': 0, 'results': [], 'error': 'query is required and must be a non-empty string'}

        cfg = self.IGlobal
        num_results = args.get('num_results', cfg.num_results)
        search_type = args.get('type', cfg.search_type)
        use_autoprompt = args.get('use_autoprompt', cfg.use_autoprompt)
        include_text = args.get('include_text', cfg.include_text)

        # Build the search request payload
        payload: Dict[str, Any] = {
            'query': query,
            'numResults': max(1, min(50, num_results)),
            'useAutoprompt': use_autoprompt,
            'type': search_type if search_type in VALID_SEARCH_TYPES else 'auto',
        }

        # Optional domain filters
        include_domains = args.get('include_domains')
        if include_domains and isinstance(include_domains, list):
            payload['includeDomains'] = include_domains

        exclude_domains = args.get('exclude_domains')
        if exclude_domains and isinstance(exclude_domains, list):
            payload['excludeDomains'] = exclude_domains

        # Optional date filters
        start_date = args.get('start_published_date')
        if start_date:
            payload['startPublishedDate'] = str(start_date)

        end_date = args.get('end_published_date')
        if end_date:
            payload['endPublishedDate'] = str(end_date)

        # If we want text content, request it inline via the contents field
        if include_text:
            payload['contents'] = {'text': True}

        headers = {
            'accept': 'application/json',
            'content-type': 'application/json',
            'x-api-key': cfg.apikey,
        }

        try:
            response = _request_with_retry(url=EXA_SEARCH_URL, headers=headers, payload=payload)
        except RuntimeError as exc:
            return {'success': False, 'query': query, 'num_results': 0, 'results': [], 'error': str(exc)}

        # Parse and structure the results
        results = []
        for item in response.get('results', []):
            result_entry: Dict[str, Any] = {
                'title': item.get('title', ''),
                'url': item.get('url', ''),
                'score': item.get('score'),
                'published_date': item.get('publishedDate'),
                'author': item.get('author'),
            }
            text = item.get('text')
            if text:
                result_entry['text'] = text
            results.append(result_entry)

        return {
            'success': True,
            'query': query,
            'num_results': len(results),
            'results': results,
        }


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _request_with_retry(
    *,
    url: str,
    headers: Dict[str, str],
    payload: Dict[str, Any],
    max_retries: int = 3,
    base_delay: float = 2.0,
) -> Dict[str, Any]:
    """Execute an HTTP POST to the Exa API with retry logic for transient errors."""
    for attempt in range(max_retries + 1):
        try:
            resp = requests.post(url, headers=headers, json=payload, timeout=30)

            if resp.status_code == 429:
                if attempt < max_retries:
                    delay = base_delay * (2**attempt)
                    debug(f'Exa rate limit hit (429), retrying in {delay}s (attempt {attempt + 1}/{max_retries})')
                    time.sleep(delay)
                    continue
                resp.raise_for_status()

            if 500 <= resp.status_code < 600:
                if attempt < max_retries:
                    delay = base_delay * (2**attempt)
                    debug(f'Exa server error ({resp.status_code}), retrying in {delay}s (attempt {attempt + 1}/{max_retries})')
                    time.sleep(delay)
                    continue
                resp.raise_for_status()

            resp.raise_for_status()
            return resp.json()

        except requests.exceptions.Timeout:
            if attempt < max_retries:
                delay = base_delay * (2**attempt)
                debug(f'Exa request timeout, retrying in {delay}s (attempt {attempt + 1}/{max_retries})')
                time.sleep(delay)
                continue
            raise RuntimeError('Exa search: request timed out after all retries') from None

        except requests.RequestException as exc:
            status = getattr(getattr(exc, 'response', None), 'status_code', None)
            detail = f' (HTTP {status})' if status else ''
            raise RuntimeError(f'Exa search request failed{detail}: {type(exc).__name__}') from None

    raise RuntimeError('Exa search: max retries exceeded')


def _normalize_tool_input(input_obj: Any) -> Dict[str, Any]:
    """Normalize tool input into a plain dict.

    Handles: None, dict, Pydantic model, JSON string, and nested ``input`` wrappers
    that some framework paths produce.
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
        except (json.JSONDecodeError, TypeError):
            warning('exa_search: failed to parse input as JSON')

    if not isinstance(input_obj, dict):
        warning(f'exa_search: unexpected input type {type(input_obj).__name__}')
        return {}

    if 'input' in input_obj and isinstance(input_obj['input'], dict):
        inner = input_obj['input']
        extras = {k: v for k, v in input_obj.items() if k != 'input'}
        input_obj = {**inner, **extras}

    input_obj.pop('security_context', None)
    return input_obj
