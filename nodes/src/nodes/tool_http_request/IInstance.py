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
HTTP Request tool node instance.

Exposes a single ``http_request`` tool that can call any HTTP API endpoint.
Security guardrails (allowed methods + URL whitelist) are enforced before
every request.
"""

from __future__ import annotations

import json

from rocketlib import IInstanceBase, tool_function

from .http_client import execute_request
from .IGlobal import IGlobal


class IInstance(IInstanceBase):
    IGlobal: IGlobal

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['url', 'method'],
            'properties': {
                'url': {
                    'type': 'string',
                    'description': 'Full URL, e.g. https://api.example.com/users/1',
                },
                'method': {
                    'type': 'string',
                    'enum': ['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT'],
                    'description': 'HTTP method',
                },
                'body_json': {
                    'description': 'JSON body for POST/PUT/PATCH. Pass a JSON object directly (e.g. {"name": "foo"}) — it will be serialized automatically.',
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
                    'properties': {'username': {'type': 'string'}, 'password': {'type': 'string'}},
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
                        'type': {'type': 'string', 'enum': ['api_key', 'basic', 'bearer', 'none']},
                        'basic': {'type': 'object', 'properties': {'username': {'type': 'string'}, 'password': {'type': 'string'}}},
                        'bearer': {'type': 'object', 'properties': {'token': {'type': 'string'}}},
                        'api_key': {'type': 'object', 'properties': {'key': {'type': 'string'}, 'value': {'type': 'string'}, 'add_to': {'type': 'string', 'enum': ['header', 'query_param']}}},
                    },
                },
                'body': {
                    'type': 'object',
                    'description': 'Advanced body config. Prefer body_json shortcut for JSON payloads.',
                    'properties': {
                        'type': {'type': 'string', 'enum': ['form_data', 'none', 'raw', 'x_www_form_urlencoded']},
                        'raw': {'type': 'object', 'properties': {'content': {'type': 'string'}, 'content_type': {'type': 'string', 'enum': ['application/json', 'application/xml', 'text/html', 'text/javascript', 'text/plain']}}},
                        'form_data': {'type': 'object', 'additionalProperties': {'type': 'string'}},
                        'urlencoded': {'type': 'object', 'additionalProperties': {'type': 'string'}},
                    },
                },
            },
        },
        description=(
            'Make an HTTP request. Required: "url" and "method". '
            'For JSON bodies, pass "body_json" as a JSON object (e.g. {"name": "foo"}) — it is serialized automatically. '
            'For bearer auth, pass "bearer_token" as a string. '
            'For basic auth, pass "basic_auth": {"username": "...", "password": "..."}. '
            'Optional: "headers", "query_params", "path_params", "timeout" (seconds, default 30, max 300).'
        ),
    )
    def http_request(self, args):
        """Make an HTTP request with security guardrails."""
        if not isinstance(args, dict):
            raise ValueError('Tool input must be a JSON object (dict)')

        # Expand convenience shortcuts into canonical form
        _normalize_shortcuts(args)

        # Validate guardrails from config
        self._validate_guardrails(args)

        return execute_request(
            url=args.get('url', ''),
            method=args.get('method', 'GET'),
            query_params=args.get('query_params'),
            path_params=args.get('path_params'),
            headers=args.get('headers'),
            auth=args.get('auth'),
            body=args.get('body'),
            timeout=args.get('timeout'),
        )

    def _validate_guardrails(self, args):
        """Enforce allowed methods + URL whitelist from config."""
        valid_methods = {'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'}
        valid_auth_types = {'none', 'basic', 'bearer', 'api_key'}
        valid_body_types = {'none', 'raw', 'form_data', 'x_www_form_urlencoded'}
        valid_raw_content_types = {'application/json', 'text/plain', 'application/xml', 'text/html', 'text/javascript'}

        method = args.get('method')
        if not method or not isinstance(method, str):
            raise ValueError('method is required and must be a non-empty string')
        if method.upper() not in valid_methods:
            raise ValueError(f'method must be one of {sorted(valid_methods)}; got {method!r}')
        if method.upper() not in self.IGlobal.enabled_methods:
            raise ValueError(f'HTTP method "{method.upper()}" is not allowed. Enabled methods: {", ".join(sorted(self.IGlobal.enabled_methods))}')

        url = args.get('url')
        if not url or not isinstance(url, str):
            raise ValueError('url is required and must be a non-empty string')
        if self.IGlobal.url_patterns and not any(p.search(url) for p in self.IGlobal.url_patterns):
            raise ValueError(f'URL "{url}" does not match any allowed URL pattern.')

        auth = args.get('auth')
        if isinstance(auth, dict):
            auth_type = (auth.get('type') or 'none').strip().lower()
            if auth_type not in valid_auth_types:
                raise ValueError(f'auth.type must be one of {sorted(valid_auth_types)}; got {auth_type!r}')

        body = args.get('body')
        if isinstance(body, dict):
            body_type = (body.get('type') or 'none').strip().lower()
            if body_type not in valid_body_types:
                raise ValueError(f'body.type must be one of {sorted(valid_body_types)}; got {body_type!r}')
            if body_type == 'raw':
                raw = body.get('raw') or {}
                ct = (raw.get('content_type') or 'application/json').strip().lower()
                if ct not in valid_raw_content_types:
                    raise ValueError(f'body.raw.content_type must be one of {sorted(valid_raw_content_types)}; got {ct!r}')


def _normalize_shortcuts(args):
    """Expand convenience shortcuts (body_json, bearer_token, basic_auth) into canonical form."""
    body_json = args.pop('body_json', None)
    if body_json is not None and not args.get('body'):
        content_str = json.dumps(body_json) if isinstance(body_json, (dict, list)) else body_json if isinstance(body_json, str) else json.dumps(body_json)
        args['body'] = {'type': 'raw', 'raw': {'content': content_str, 'content_type': 'application/json'}}

    bearer_token = args.pop('bearer_token', None)
    if bearer_token is not None and not args.get('auth'):
        args['auth'] = {'type': 'bearer', 'bearer': {'token': str(bearer_token)}}

    basic_auth = args.pop('basic_auth', None)
    if isinstance(basic_auth, dict) and not args.get('auth'):
        args['auth'] = {'type': 'basic', 'basic': basic_auth}
