# =============================================================================
# MIT License
# Copyright (c) 2024 RocketRide Inc.
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
http_request tool-provider driver.

Implements ``tool.query``, ``tool.validate``, and ``tool.invoke`` by exposing a
single ``http_request`` tool that can call any HTTP API endpoint.  Security
guardrails (allowed methods + URL whitelist) are enforced before every request.
"""

from __future__ import annotations

import json
import re
from typing import Any, Dict, List, Set

from ai.common.tools import ToolsBase

from .http_client import execute_request
from .ssrf_guard import validate_url

VALID_METHODS = {'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'}
VALID_AUTH_TYPES = {'none', 'basic', 'bearer', 'api_key'}
VALID_BODY_TYPES = {'none', 'raw', 'form_data', 'x_www_form_urlencoded'}
VALID_RAW_CONTENT_TYPES = {
    'application/json',
    'text/plain',
    'application/xml',
    'text/html',
    'text/javascript',
}

INPUT_SCHEMA: Dict[str, Any] = {
    'type': 'object',
    'required': ['url', 'method'],
    'properties': {
        'url': {
            'type': 'string',
            'description': 'Full URL, e.g. https://api.example.com/users/1',
        },
        'method': {
            'type': 'string',
            'enum': sorted(VALID_METHODS),
            'description': 'HTTP method',
        },
        'body_json': {
            'description': 'JSON body for POST/PUT/PATCH. Pass a JSON object directly (e.g. {"name": "foo"}) — it will be serialized automatically. This is the easiest way to send JSON.',
        },
        'query_params': {
            'type': 'object',
            'description': 'Key-value query parameters appended to the URL',
            'additionalProperties': {'type': 'string'},
        },
        'headers': {
            'type': 'object',
            'description': 'Custom HTTP headers',
            'additionalProperties': {'type': 'string'},
        },
        'bearer_token': {
            'type': 'string',
            'description': 'Bearer token for Authorization header. Just pass the token string.',
        },
        'basic_auth': {
            'type': 'object',
            'description': 'Basic auth credentials',
            'properties': {
                'username': {'type': 'string'},
                'password': {'type': 'string'},
            },
        },
        'timeout': {
            'type': 'number',
            'description': 'Request timeout in seconds. Defaults to 30. Increase for slow APIs (max 300).',
        },
        'path_params': {
            'type': 'object',
            'description': 'Path parameter replacements (e.g. {"id": "123"} replaces :id in the URL)',
            'additionalProperties': {'type': 'string'},
        },
        'auth': {
            'type': 'object',
            'description': 'Advanced auth config. Prefer bearer_token or basic_auth shortcuts instead.',
            'properties': {
                'type': {
                    'type': 'string',
                    'enum': sorted(VALID_AUTH_TYPES),
                },
                'basic': {
                    'type': 'object',
                    'properties': {
                        'username': {'type': 'string'},
                        'password': {'type': 'string'},
                    },
                },
                'bearer': {
                    'type': 'object',
                    'properties': {
                        'token': {'type': 'string'},
                    },
                },
                'api_key': {
                    'type': 'object',
                    'properties': {
                        'key': {'type': 'string'},
                        'value': {'type': 'string'},
                        'add_to': {
                            'type': 'string',
                            'enum': ['header', 'query_param'],
                        },
                    },
                },
            },
        },
        'body': {
            'type': 'object',
            'description': 'Advanced body config. Prefer body_json shortcut for JSON payloads.',
            'properties': {
                'type': {
                    'type': 'string',
                    'enum': sorted(VALID_BODY_TYPES),
                },
                'raw': {
                    'type': 'object',
                    'properties': {
                        'content': {'type': 'string'},
                        'content_type': {
                            'type': 'string',
                            'enum': sorted(VALID_RAW_CONTENT_TYPES),
                        },
                    },
                },
                'form_data': {
                    'type': 'object',
                    'additionalProperties': {'type': 'string'},
                },
                'urlencoded': {
                    'type': 'object',
                    'additionalProperties': {'type': 'string'},
                },
            },
        },
    },
}


class HttpDriver(ToolsBase):
    def __init__(  # noqa: D107
        self,
        *,
        server_name: str,
        enabled_methods: Set[str],
        url_patterns: List[re.Pattern],
    ):
        self._server_name = (server_name or '').strip() or 'http'
        self._tool_name = 'http_request'
        self._namespaced = f'{self._server_name}.{self._tool_name}'
        self._enabled_methods = enabled_methods
        self._url_patterns = url_patterns

    # ------------------------------------------------------------------
    # ToolsBase hooks
    # ------------------------------------------------------------------

    def _tool_query(self) -> List[Dict[str, Any]]:
        return [
            {
                'name': self._namespaced,
                'description': (
                    'Make an HTTP request. Required: "url" and "method". '
                    'For JSON bodies, pass "body_json" as a JSON object (e.g. {"name": "foo"}) — it is serialized automatically. '
                    'For bearer auth, pass "bearer_token" as a string. '
                    'For basic auth, pass "basic_auth": {"username": "...", "password": "..."}. '
                    'Optional: "headers", "query_params", "path_params", "timeout" (seconds, default 30, max 300).'
                ),
                'inputSchema': INPUT_SCHEMA,
            }
        ]

    @staticmethod
    def _normalize_shortcuts(input_obj: Dict[str, Any]) -> Dict[str, Any]:
        """Expand convenience shortcuts into the canonical nested format.

        Mutates and returns *input_obj* so that downstream validate/invoke
        only need to understand the canonical ``body`` and ``auth`` shapes.
        """
        # --- body_json  ->  body ---
        body_json = input_obj.pop('body_json', None)
        if body_json is not None and not input_obj.get('body'):
            if isinstance(body_json, (dict, list)):
                content_str = json.dumps(body_json)
            else:
                content_str = str(body_json)
            input_obj['body'] = {
                'type': 'raw',
                'raw': {
                    'content': content_str,
                    'content_type': 'application/json',
                },
            }

        # --- bearer_token  ->  auth ---
        bearer_token = input_obj.pop('bearer_token', None)
        if bearer_token is not None and not input_obj.get('auth'):
            input_obj['auth'] = {
                'type': 'bearer',
                'bearer': {'token': str(bearer_token)},
            }

        # --- basic_auth  ->  auth ---
        basic_auth = input_obj.pop('basic_auth', None)
        if isinstance(basic_auth, dict) and not input_obj.get('auth'):
            input_obj['auth'] = {
                'type': 'basic',
                'basic': basic_auth,
            }

        return input_obj

    def _tool_validate(self, *, tool_name: str, input_obj: Any) -> None:  # noqa: ANN401
        if tool_name != self._tool_name and tool_name != self._namespaced:
            raise ValueError(f'Unknown tool {tool_name!r} (expected {self._tool_name!r})')

        if not isinstance(input_obj, dict):
            raise ValueError('Tool input must be a JSON object')

        # --- Guardrail: allowed methods ---
        method = input_obj.get('method')
        if not method or not isinstance(method, str):
            raise ValueError('method is required and must be a non-empty string')
        if method.upper() not in VALID_METHODS:
            raise ValueError(f'method must be one of {sorted(VALID_METHODS)}; got {method!r}')
        if method.upper() not in self._enabled_methods:
            raise ValueError(f'HTTP method "{method.upper()}" is not allowed. Enabled methods: {", ".join(sorted(self._enabled_methods))}')

        # --- Guardrail: URL whitelist (empty list = allow all) ---
        url = input_obj.get('url')
        if not url or not isinstance(url, str):
            raise ValueError('url is required and must be a non-empty string')
        if self._url_patterns and not any(p.search(url) for p in self._url_patterns):
            raise ValueError(f'URL "{url}" does not match any allowed URL pattern.')

        # --- Standard field validation ---
        auth = input_obj.get('auth')
        if isinstance(auth, dict):
            auth_type = (auth.get('type') or 'none').strip().lower()
            if auth_type not in VALID_AUTH_TYPES:
                raise ValueError(f'auth.type must be one of {sorted(VALID_AUTH_TYPES)}; got {auth_type!r}')

        body = input_obj.get('body')
        if isinstance(body, dict):
            body_type = (body.get('type') or 'none').strip().lower()
            if body_type not in VALID_BODY_TYPES:
                raise ValueError(f'body.type must be one of {sorted(VALID_BODY_TYPES)}; got {body_type!r}')
            if body_type == 'raw':
                raw = body.get('raw') or {}
                ct = (raw.get('content_type') or 'application/json').strip().lower()
                if ct not in VALID_RAW_CONTENT_TYPES:
                    raise ValueError(f'body.raw.content_type must be one of {sorted(VALID_RAW_CONTENT_TYPES)}; got {ct!r}')

    def _tool_invoke(self, *, tool_name: str, input_obj: Any) -> Any:  # noqa: ANN401
        if not isinstance(input_obj, dict):
            raise ValueError('Tool input must be a JSON object (dict)')

        self._normalize_shortcuts(input_obj)
        self._tool_validate(tool_name=tool_name, input_obj=input_obj)

        validate_url(input_obj.get('url', ''))

        return execute_request(
            url=input_obj.get('url', ''),
            method=input_obj.get('method', 'GET'),
            query_params=input_obj.get('query_params'),
            path_params=input_obj.get('path_params'),
            headers=input_obj.get('headers'),
            auth=input_obj.get('auth'),
            body=input_obj.get('body'),
            timeout=input_obj.get('timeout'),
        )
