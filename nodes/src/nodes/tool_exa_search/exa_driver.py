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
Exa Search tool-provider driver.

Implements ``tool.query``, ``tool.validate``, and ``tool.invoke`` for the Exa
semantic web search API.  Exposes a single ``exa_search`` tool that agents can
invoke with a natural-language query to retrieve real-time web results.
"""

from __future__ import annotations

import json
import time
from typing import Any, Dict, List

import requests

from rocketlib import debug, warning

from ai.common.tools import ToolsBase

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

EXA_SEARCH_URL = 'https://api.exa.ai/search'

VALID_SEARCH_TYPES = {'auto', 'neural', 'keyword'}

INPUT_SCHEMA: Dict[str, Any] = {
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
}


class ExaSearchDriver(ToolsBase):
    """Tool provider for Exa semantic web search."""

    def __init__(
        self,
        *,
        server_name: str,
        apikey: str,
        num_results: int = 10,
        use_autoprompt: bool = True,
        search_type: str = 'auto',
        include_text: bool = True,
    ) -> None:
        """Initialize the Exa search driver with API key and default search parameters."""
        self._server_name = (server_name or '').strip() or 'exa'
        self._apikey = apikey
        self._num_results = max(1, min(50, num_results))
        self._use_autoprompt = use_autoprompt
        self._search_type = search_type if search_type in VALID_SEARCH_TYPES else 'auto'
        self._include_text = include_text

    def _bare_name(self, tool_name: str) -> str:
        """Strip server prefix, accepting both bare and namespaced tool names."""
        prefix = f'{self._server_name}.'
        return tool_name[len(prefix) :] if tool_name.startswith(prefix) else tool_name

    # ------------------------------------------------------------------
    # ToolsBase hooks
    # ------------------------------------------------------------------

    def _tool_query(self) -> List[ToolsBase.ToolDescriptor]:
        return [
            {
                'name': f'{self._server_name}.exa_search',
                'description': (
                    'Search the web using Exa semantic search. '
                    'Provide a natural language "query" to find relevant web pages. '
                    'Returns structured results with title, URL, text content, relevance score, and published date. '
                    'Optional: "num_results", "type" (auto/neural/keyword), "use_autoprompt", '
                    '"include_domains", "exclude_domains", "start_published_date", "end_published_date", "include_text".'
                ),
                'inputSchema': INPUT_SCHEMA,
            }
        ]

    def _tool_validate(self, *, tool_name: str, input_obj: Any) -> None:  # noqa: ANN401
        bare = self._bare_name(tool_name)
        if bare != 'exa_search':
            raise ValueError(f'Unknown tool {tool_name!r} (expected exa_search)')

        if not isinstance(input_obj, dict):
            raise ValueError('Tool input must be a JSON object')

        query = input_obj.get('query')
        if not query or not isinstance(query, str) or not query.strip():
            raise ValueError('query is required and must be a non-empty string')

        search_type = input_obj.get('type')
        if search_type is not None and search_type not in VALID_SEARCH_TYPES:
            raise ValueError(f'type must be one of {sorted(VALID_SEARCH_TYPES)}; got {search_type!r}')

        num_results = input_obj.get('num_results')
        if num_results is not None:
            if not isinstance(num_results, int) or num_results < 1 or num_results > 50:
                raise ValueError('num_results must be an integer between 1 and 50')

    def _tool_invoke(self, *, tool_name: str, input_obj: Any) -> Any:  # noqa: ANN401
        input_obj = _normalize_tool_input(input_obj)
        self._tool_validate(tool_name=tool_name, input_obj=input_obj)
        return self._invoke_search(input_obj)

    # ------------------------------------------------------------------
    # Search implementation
    # ------------------------------------------------------------------

    def _invoke_search(self, args: Dict[str, Any]) -> Dict[str, Any]:
        query = args['query'].strip()
        num_results = args.get('num_results', self._num_results)
        search_type = args.get('type', self._search_type)
        use_autoprompt = args.get('use_autoprompt', self._use_autoprompt)
        include_text = args.get('include_text', self._include_text)

        # Build the search request payload
        payload: Dict[str, Any] = {
            'query': query,
            'numResults': max(1, min(50, num_results)),
            'useAutoprompt': use_autoprompt,
            'type': search_type,
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
            payload['contents'] = {
                'text': True,
            }

        headers = {
            'accept': 'application/json',
            'content-type': 'application/json',
            'x-api-key': self._apikey,
        }

        response = _request_with_retry(
            url=EXA_SEARCH_URL,
            headers=headers,
            payload=payload,
        )

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
            # Text content is returned inline when contents.text is requested
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
            # Re-raise with a sanitized message so the API key in headers is never leaked.
            status = getattr(getattr(exc, 'response', None), 'status_code', None)
            detail = f' (HTTP {status})' if status else ''
            raise RuntimeError(f'Exa search request failed{detail}: {type(exc).__name__}') from None

    # Should not reach here, but just in case
    raise RuntimeError('Exa search: max retries exceeded')


def _normalize_tool_input(input_obj: Any) -> Dict[str, Any]:
    """Normalize whatever the engine/framework passes as tool input into a plain dict.

    Handles: None, dict, Pydantic model, JSON string, and nested ``input`` wrappers
    that some framework paths produce.
    """
    if input_obj is None:
        return {}

    # Pydantic model -> dict
    if hasattr(input_obj, 'model_dump') and callable(getattr(input_obj, 'model_dump')):
        input_obj = input_obj.model_dump()
    elif hasattr(input_obj, 'dict') and callable(getattr(input_obj, 'dict')):
        input_obj = input_obj.dict()

    # JSON string -> dict
    if isinstance(input_obj, str):
        try:
            parsed = json.loads(input_obj)
            if isinstance(parsed, dict):
                input_obj = parsed
        except Exception:
            pass

    if not isinstance(input_obj, dict):
        warning(f'exa_search: unexpected input type {type(input_obj).__name__}: {input_obj!r}')
        return {}

    # Unwrap ``{"input": {...}}`` wrappers that some framework paths leave behind
    if 'input' in input_obj and isinstance(input_obj['input'], dict):
        inner = input_obj['input']
        extras = {k: v for k, v in input_obj.items() if k != 'input'}
        input_obj = {**inner, **extras}

    # Drop framework-injected keys that aren't tool args
    input_obj.pop('security_context', None)

    return input_obj
