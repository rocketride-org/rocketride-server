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
Tavily tool node instance.

Exposes ``tavily`` as a @tool_function for real-time web search via the Tavily API.
"""

from __future__ import annotations

from typing import Any, Dict

import requests

from rocketlib import IInstanceBase, tool_function

from ai.common.utils import normalize_tool_input, post_with_retry, validate_public_url

from .IGlobal import IGlobal

TAVILY_API_URL = 'https://api.tavily.com/search'
VALID_SEARCH_DEPTHS = {'basic', 'advanced'}
VALID_TOPICS = {'general', 'news', 'finance'}
VALID_TIME_RANGES = {'day', 'week', 'month', 'year'}


class IInstance(IInstanceBase):
    """Node instance exposing Tavily web search as an agent tool."""

    IGlobal: IGlobal

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['query'],
            'properties': {
                'query': {
                    'type': 'string',
                    'description': 'The search query — a natural language question or keyword phrase.',
                },
                'max_results': {
                    'type': 'integer',
                    'description': 'Number of results to return (1-20). Defaults to the node config value.',
                },
                'search_depth': {
                    'type': 'string',
                    'enum': sorted(VALID_SEARCH_DEPTHS),
                    'description': '"basic" (fast) or "advanced" (deeper). Defaults to node config.',
                },
                'topic': {
                    'type': 'string',
                    'enum': sorted(VALID_TOPICS),
                    'description': 'Search category: "general", "news", or "finance".',
                },
                'time_range': {
                    'type': 'string',
                    'enum': sorted(VALID_TIME_RANGES),
                    'description': 'Restrict results to a recent time window.',
                },
                'include_domains': {
                    'type': 'array',
                    'items': {'type': 'string'},
                    'description': 'Only return results from these domains.',
                },
                'exclude_domains': {
                    'type': 'array',
                    'items': {'type': 'string'},
                    'description': 'Exclude results from these domains.',
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
        description='Search the web in real time using Tavily. Provide a natural language query to find relevant, current web pages. Returns structured results with title, URL, content snippet, and relevance score.',
    )
    def tavily(self, args):
        """Search the web using the Tavily API."""
        args = normalize_tool_input(args, tool_name='tavily')

        query = (args.get('query') or '').strip()
        if not query:
            return {
                'success': False,
                'query': '',
                'num_results': 0,
                'results': [],
                'error': 'query is required and must be a non-empty string',
            }

        cfg = self.IGlobal

        max_results = args.get('max_results', cfg.max_results)
        if isinstance(max_results, bool) or not isinstance(max_results, int):
            max_results = cfg.max_results
        search_depth = args.get('search_depth', cfg.search_depth)
        if search_depth not in VALID_SEARCH_DEPTHS:
            search_depth = cfg.search_depth
        topic = args.get('topic', cfg.topic)
        if topic not in VALID_TOPICS:
            topic = cfg.topic

        payload: Dict[str, Any] = {
            'query': query,
            'max_results': max(1, min(20, max_results)),
            'search_depth': search_depth,
            'topic': topic,
        }
        time_range = args.get('time_range')
        if time_range in VALID_TIME_RANGES:
            payload['time_range'] = time_range
        include_domains = args.get('include_domains')
        if include_domains and isinstance(include_domains, list):
            payload['include_domains'] = include_domains
        exclude_domains = args.get('exclude_domains')
        if exclude_domains and isinstance(exclude_domains, list):
            payload['exclude_domains'] = exclude_domains

        headers = {
            'accept': 'application/json',
            'content-type': 'application/json',
            'authorization': f'Bearer {cfg.apikey}',
        }

        try:
            resp = post_with_retry(TAVILY_API_URL, headers=headers, json=payload)
            body = resp.json()
        except requests.exceptions.InvalidJSONError:
            # resp.json() raises JSONDecodeError (subclass of InvalidJSONError
            # AND RequestException) — catch it first to avoid the generic handler.
            return {
                'success': False,
                'query': query,
                'num_results': 0,
                'results': [],
                'error': 'Tavily returned a non-JSON response body',
            }
        except requests.RequestException as exc:
            status = getattr(getattr(exc, 'response', None), 'status_code', None)
            detail = f' (HTTP {status})' if status else ''
            return {
                'success': False,
                'query': query,
                'num_results': 0,
                'results': [],
                'error': f'Tavily request failed{detail}: {type(exc).__name__}',
            }
        if not isinstance(body, dict):
            return {
                'success': False,
                'query': query,
                'num_results': 0,
                'results': [],
                'error': f'Tavily returned an unexpected payload type: {type(body).__name__}',
            }

        return _shape_results(query, body)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _shape_results(query: str, body: Dict[str, Any]) -> Dict[str, Any]:
    """Map a Tavily response body into the tool's output schema, dropping unsafe URLs."""
    raw_results = body.get('results', []) or []
    if not isinstance(raw_results, list):
        return {
            'success': False,
            'query': query,
            'num_results': 0,
            'results': [],
            'error': 'Tavily returned an unexpected results payload',
        }

    results = []
    for item in raw_results:
        if not isinstance(item, dict):
            continue
        url = item.get('url', '')
        if not url:
            continue
        try:
            url = validate_public_url(url)
        except ValueError:
            continue
        results.append(
            {
                'title': item.get('title', ''),
                'url': url,
                'content': item.get('content', ''),
                'score': item.get('score'),
                'published_date': item.get('published_date'),
            }
        )
    return {'success': True, 'query': query, 'num_results': len(results), 'results': results}
