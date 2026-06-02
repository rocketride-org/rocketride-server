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

import ipaddress
import socket
import time
from typing import Any, Dict
from urllib.parse import urlparse

import requests

from rocketlib import IInstanceBase, tool_function, debug

from ai.common.utils import normalize_tool_input

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
                    'enum': ['day', 'week', 'month', 'year'],
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
            body = _request_with_retry(url=TAVILY_API_URL, headers=headers, payload=payload)
        except RuntimeError as exc:
            return {'success': False, 'query': query, 'num_results': 0, 'results': [], 'error': str(exc)}

        return _shape_results(query, body)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _shape_results(query: str, body: Dict[str, Any]) -> Dict[str, Any]:
    """Map a Tavily response body into the tool's output schema, dropping unsafe URLs."""
    results = []
    for item in body.get('results', []) or []:
        url = item.get('url', '')
        if not url:
            continue
        try:
            url = _validate_public_url(url)
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


def _validate_public_url(raw_url: str) -> str:
    """Reject private/loopback/reserved hosts to prevent SSRF (clone of search_exa)."""
    parsed = urlparse(raw_url)
    if parsed.scheme not in ('http', 'https') or not parsed.hostname:
        raise ValueError(f'Tavily returned an invalid URL: {raw_url}')
    try:
        addrinfo = socket.getaddrinfo(parsed.hostname, None, type=socket.SOCK_STREAM)
    except socket.gaierror as e:
        raise ValueError(f'Tavily returned an unresolved URL host: {parsed.hostname}') from e
    for _, _, _, _, sockaddr in addrinfo:
        ip = ipaddress.ip_address(sockaddr[0])
        if (
            ip.is_private
            or ip.is_loopback
            or ip.is_link_local
            or ip.is_reserved
            or ip.is_multicast
            or ip.is_unspecified
        ):
            raise ValueError(f'Tavily returned a blocked URL host: {parsed.hostname}')
    return raw_url


def _request_with_retry(
    *, url: str, headers: Dict[str, str], payload: Dict[str, Any], max_retries: int = 3, base_delay: float = 2.0
) -> Dict[str, Any]:
    """POST to the Tavily API with exponential-backoff retry on 429/5xx (clone of tool_exa_search)."""
    for attempt in range(max_retries + 1):
        try:
            resp = requests.post(url, headers=headers, json=payload, timeout=30)

            if resp.status_code == 429:
                if attempt < max_retries:
                    delay = base_delay * (2**attempt)
                    debug(f'Tavily rate limit hit (429), retrying in {delay}s (attempt {attempt + 1}/{max_retries})')
                    time.sleep(delay)
                    continue
                resp.raise_for_status()

            if 500 <= resp.status_code < 600:
                if attempt < max_retries:
                    delay = base_delay * (2**attempt)
                    debug(
                        f'Tavily server error ({resp.status_code}), retrying in {delay}s (attempt {attempt + 1}/{max_retries})'
                    )
                    time.sleep(delay)
                    continue
                resp.raise_for_status()

            resp.raise_for_status()
            try:
                data = resp.json()
            except ValueError as exc:
                # A 200 with a non-JSON body would otherwise raise ValueError,
                # which tavily() does not catch; convert it to the RuntimeError
                # contract so the caller returns {'success': False, ...}.
                raise RuntimeError('Tavily returned a non-JSON response body') from exc
            if not isinstance(data, dict):
                raise RuntimeError(f'Tavily returned an unexpected payload type: {type(data).__name__}')
            return data

        except (requests.exceptions.Timeout, requests.exceptions.ConnectionError) as exc:
            # Transient transport failures (timeouts, dropped/refused connections)
            # are retried with the same backoff as 429/5xx responses.
            if attempt < max_retries:
                delay = base_delay * (2**attempt)
                debug(
                    f'Tavily transport error ({type(exc).__name__}), retrying in {delay}s ({attempt + 1}/{max_retries})'
                )
                time.sleep(delay)
                continue
            raise RuntimeError(f'Tavily: {type(exc).__name__} after all retries') from None
        except requests.RequestException as exc:
            status = getattr(getattr(exc, 'response', None), 'status_code', None)
            detail = f' (HTTP {status})' if status else ''
            raise RuntimeError(f'Tavily request failed{detail}: {type(exc).__name__}') from None
    raise RuntimeError('Tavily: max retries exceeded')
