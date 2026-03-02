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
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OF OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================

"""
http_request tool-provider driver.

Implements ``tool.query``, ``tool.validate``, and ``tool.invoke`` by exposing a
single ``http_request`` tool that can call any HTTP API endpoint.
"""

from __future__ import annotations

from typing import Any, Dict, List

from ai.common.tools import ToolsBase

from .http_client import execute_request

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
            'description': 'Full URL (supports :param path parameters, e.g. https://api.example.com/users/:id)',
        },
        'method': {
            'type': 'string',
            'enum': sorted(VALID_METHODS),
            'description': 'HTTP method',
        },
        'query_params': {
            'type': 'object',
            'description': 'Key-value query parameters appended to the URL',
            'additionalProperties': {'type': 'string'},
        },
        'path_params': {
            'type': 'object',
            'description': 'Path parameter replacements (e.g. {"id": "123"} replaces :id in the URL)',
            'additionalProperties': {'type': 'string'},
        },
        'headers': {
            'type': 'object',
            'description': 'Custom HTTP headers',
            'additionalProperties': {'type': 'string'},
        },
        'auth': {
            'type': 'object',
            'description': 'Authentication configuration',
            'properties': {
                'type': {
                    'type': 'string',
                    'enum': sorted(VALID_AUTH_TYPES),
                    'description': 'Auth type (none, basic, bearer, api_key)',
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
                        'key': {'type': 'string', 'description': 'Header or query-param name'},
                        'value': {'type': 'string', 'description': 'The API key value'},
                        'add_to': {
                            'type': 'string',
                            'enum': ['header', 'query_param'],
                            'description': 'Where to attach the key (default: header)',
                        },
                    },
                },
            },
        },
        'body': {
            'type': 'object',
            'description': 'Request body configuration',
            'properties': {
                'type': {
                    'type': 'string',
                    'enum': sorted(VALID_BODY_TYPES),
                    'description': 'Body type (none, raw, form_data, x_www_form_urlencoded)',
                },
                'raw': {
                    'type': 'object',
                    'properties': {
                        'content': {'type': 'string', 'description': 'Raw body content'},
                        'content_type': {
                            'type': 'string',
                            'enum': sorted(VALID_RAW_CONTENT_TYPES),
                            'description': 'Content-Type header value (default: application/json)',
                        },
                    },
                },
                'form_data': {
                    'type': 'object',
                    'description': 'Key-value pairs sent as multipart/form-data',
                    'additionalProperties': {'type': 'string'},
                },
                'urlencoded': {
                    'type': 'object',
                    'description': 'Key-value pairs sent as application/x-www-form-urlencoded',
                    'additionalProperties': {'type': 'string'},
                },
            },
        },
    },
}


class HttpDriver(ToolsBase):
    def __init__(self, *, server_name: str, defaults: Dict[str, Any] | None = None):
        self._server_name = (server_name or '').strip() or 'http'
        self._tool_name = 'http_request'
        self._namespaced = f'{self._server_name}.{self._tool_name}'
        self._defaults: Dict[str, Any] = defaults or {}

    # ------------------------------------------------------------------
    # ToolsBase hooks
    # ------------------------------------------------------------------

    def _tool_query(self) -> List[Dict[str, Any]]:
        return [
            {
                'name': self._namespaced,
                'description': (
                    'Make an HTTP request to any API endpoint. '
                    'You MUST always specify both "url" and "method" (GET, POST, PUT, PATCH, DELETE, HEAD, or OPTIONS). '
                    'For POST/PUT/PATCH requests, include a "body" object with "type" set to "raw" and a nested "raw" '
                    'object containing "content" (the JSON string) and "content_type" (e.g. "application/json"). '
                    'You can also pass "headers" (object of key-value pairs), "query_params" (object of key-value pairs), '
                    'and "auth" (with "type": "bearer"/"basic"/"api_key" and corresponding credentials).'
                ),
                'inputSchema': INPUT_SCHEMA,
            }
        ]

    def _tool_validate(self, *, tool_name: str, input_obj: Any) -> None:  # noqa: ANN401
        if tool_name != self._tool_name and tool_name != self._namespaced:
            raise ValueError(f'Unknown tool {tool_name!r} (expected {self._tool_name!r})')

        if not isinstance(input_obj, dict):
            raise ValueError('Tool input must be a JSON object')

        url = input_obj.get('url')
        if not url or not isinstance(url, str):
            raise ValueError('url is required and must be a non-empty string')

        method = input_obj.get('method')
        if not method or not isinstance(method, str):
            raise ValueError('method is required and must be a non-empty string')
        if method.upper() not in VALID_METHODS:
            raise ValueError(f'method must be one of {sorted(VALID_METHODS)}; got {method!r}')

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
                    raise ValueError(
                        f'body.raw.content_type must be one of {sorted(VALID_RAW_CONTENT_TYPES)}; got {ct!r}'
                    )

    def _tool_invoke(self, *, tool_name: str, input_obj: Any) -> Any:  # noqa: ANN401
        if not isinstance(input_obj, dict):
            raise ValueError('Tool input must be a JSON object (dict)')

        merged = self._merge_with_defaults(input_obj)

        return execute_request(
            url=merged.get('url', ''),
            method=merged.get('method', 'GET'),
            query_params=merged.get('query_params'),
            path_params=merged.get('path_params'),
            headers=merged.get('headers'),
            auth=merged.get('auth'),
            body=merged.get('body'),
        )

    def _merge_with_defaults(self, agent_input: Dict[str, Any]) -> Dict[str, Any]:
        """Merge user-configured defaults with agent runtime input.

        Priority: agent input > user config > field defaults.
        For dict-type fields (headers, query_params, path_params), config
        values serve as the base and agent values are overlaid on top.
        """
        if not self._defaults:
            return agent_input

        merged: Dict[str, Any] = {}

        for key in ('url', 'method', 'auth', 'body'):
            agent_val = agent_input.get(key)
            default_val = self._defaults.get(key)
            if agent_val is not None:
                merged[key] = agent_val
            elif default_val is not None:
                merged[key] = default_val

        for key in ('headers', 'query_params', 'path_params'):
            default_val = self._defaults.get(key)
            agent_val = agent_input.get(key)
            if isinstance(default_val, dict) and isinstance(agent_val, dict):
                combined = {**default_val, **agent_val}
                merged[key] = combined
            elif agent_val is not None:
                merged[key] = agent_val
            elif default_val is not None:
                merged[key] = default_val

        return merged
