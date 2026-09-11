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

Exposes a single ``http_request`` tool that can call public HTTP API endpoints.
Security guardrails (allowed methods, URL whitelist, and public-network-only
destinations) are enforced before every request.
"""

from __future__ import annotations

import json
import re
from urllib.parse import urlsplit

from rocketlib import IInstanceBase, tool_function

from .http_client import _build_final_url, execute_request
from .IGlobal import IGlobal


def _match(pattern, url):
    """Apply a configured regex without interpreting or rewriting its syntax."""
    try:
        return pattern.match(url)
    except (TypeError, ValueError):
        return None


def _take_literal_scheme(source):
    """Return an exact HTTP(S) scheme and the first authority-source index."""
    position = 2 if source.startswith(r'\A') else 1 if source.startswith('^') else 0
    for scheme in ('https', 'http'):
        prefix = f'{scheme}://'
        if source.startswith(prefix, position):
            return scheme, position + len(prefix)
    return None


def _take_exact_host(source, position):
    """Parse one literal/escaped DNS, IPv4, or bracketed-IPv6 host."""
    bracketed = source.startswith(r'\[', position)
    if bracketed:
        position += 2

    literal = []
    while position < len(source):
        if bracketed and source.startswith(r'\]', position):
            if not literal:
                return None
            return f'[{"".join(literal)}]', position + 2

        character = source[position]
        if character == '\\':
            if position + 1 < len(source) and source[position + 1] in '.-_':
                literal.append(source[position + 1])
                position += 2
                continue
            break

        allowed = character.isascii() and (character.isalnum() or character in '-_%')
        if bracketed:
            allowed = allowed or character == ':'
        if not allowed:
            break
        literal.append(character)
        position += 1

    if bracketed or not literal:
        return None
    return ''.join(literal), position


def _take_positive_numeric_quantifier(source, position):
    """Return a quantifier endpoint and its inclusive length bounds."""
    if position < len(source) and source[position] == '+':
        return position + 1, 1, None
    if position >= len(source) or source[position] != '{':
        return position, 1, 1

    end = source.find('}', position + 1)
    if end < 0:
        return None
    fields = source[position + 1 : end].split(',')
    if len(fields) > 2 or not fields[0].isdigit():
        return None
    if len(fields) == 2 and fields[1] and not fields[1].isdigit():
        return None
    try:
        minimum = int(fields[0])
        maximum = int(fields[1]) if len(fields) == 2 and fields[1] else None
    except (ValueError, OverflowError):
        return None
    if minimum < 1 or maximum is not None and maximum < minimum:
        return None
    if len(fields) == 1:
        maximum = minimum
    return end + 1, minimum, maximum


def _take_numeric_port(source, position):
    """Parse an exact port or a nonempty decimal-digit language."""
    digit_start = position
    while position < len(source) and source[position].isdigit():
        position += 1
    if position > digit_start:
        return position, source[digit_start:position], None, None
    if not source.startswith('[0-9]', position):
        return None
    quantifier = _take_positive_numeric_quantifier(source, position + len('[0-9]'))
    if quantifier is None:
        return None
    end, minimum, maximum = quantifier
    return end, None, minimum, maximum


def _take_port_policy(source, position):
    """Parse no port, a required numeric port, or an optional numeric port."""
    if source.startswith('(?::', position):
        port_policy = _take_numeric_port(source, position + len('(?::'))
        if port_policy is not None and source.startswith(')?', port_policy[0]):
            return port_policy[0] + 2, True, port_policy[1:]
        return None
    if position < len(source) and source[position] == ':':
        port_policy = _take_numeric_port(source, position + 1)
        if port_policy is None:
            return None
        return port_policy[0], False, port_policy[1:]
    return position, False, None


def _explicit_port_text(netloc):
    """Return the canonical authority's explicit port without normalizing it."""
    if netloc.startswith('['):
        close = netloc.find(']')
        suffix = netloc[close + 1 :]
        return suffix[1:] if suffix.startswith(':') else None
    separator = netloc.rfind(':')
    return netloc[separator + 1 :] if separator >= 0 else None


def _port_policy_matches(port_policy, optional, actual_port):
    """Return whether an explicit port satisfies a recognized source policy."""
    if port_policy is None:
        return actual_port is None
    if actual_port is None:
        return optional
    literal, minimum, maximum = port_policy
    if literal is not None:
        return actual_port == literal
    return actual_port.isdigit() and len(actual_port) >= minimum and (maximum is None or len(actual_port) <= maximum)


def _take_authority_boundary(source, position):
    """Return the boundary endpoint, semantics, and accepted URL delimiter."""
    if position < len(source) and source[position] == '/':
        return position + 1, False, frozenset({'/'})
    if source.startswith(r'\?', position):
        return position + 2, False, frozenset({'?'})
    boundaries = {
        '(?=/|$)': frozenset({'/', ''}),
        '(?:/|$)': frozenset({'/', ''}),
        r'(?=\?|$)': frozenset({'?', ''}),
        r'(?:\?|$)': frozenset({'?', ''}),
        '(?=/|\\?|$)': frozenset({'/', '?', ''}),
        '(?:/|\\?|$)': frozenset({'/', '?', ''}),
    }
    for boundary, delimiters in boundaries.items():
        if source.startswith(boundary, position):
            return position + len(boundary), True, delimiters
    if source[position:] in ('$', r'\Z', r'\z'):
        return len(source), source[position:] == '$', frozenset({''})
    return None


def _inline_flag_group(source, position, verbose):
    """Return an inline-flag group endpoint, scope kind, and verbose mode."""
    if not source.startswith('(?', position):
        return None
    flag_end = position + 2
    while flag_end < len(source) and source[flag_end] in 'aiLmsux-':
        flag_end += 1
    flag_text = source[position + 2 : flag_end]
    if not flag_text or flag_end >= len(source) or source[flag_end] not in ':)':
        return None

    enabled, separator, disabled = flag_text.partition('-')
    if 'x' in enabled:
        verbose = True
    if separator and 'x' in disabled:
        verbose = False
    return flag_end + 1, source[flag_end] == ':', verbose


def _tail_has_no_outer_alternation(source, position, flags):
    """Allow arbitrary post-boundary regex syntax, but not an outer branch."""
    depth = 0
    index = position
    verbose_modes = [bool(flags & re.VERBOSE)]
    while index < len(source):
        if source[index] == '\\':
            index += 2
            continue
        if source.startswith('(?#', index):
            comment_end = source.find(')', index + 3)
            if comment_end < 0:
                return False
            index = comment_end + 1
            continue
        if verbose_modes[-1] and source[index] == '#':
            newline = source.find('\n', index + 1)
            index = len(source) if newline < 0 else newline + 1
            continue
        if source[index] == '[':
            index += 1
            if index < len(source) and source[index] == '^':
                index += 1
            if index < len(source) and source[index] == ']':
                index += 1
            while index < len(source) and source[index] != ']':
                index += 2 if source[index] == '\\' else 1
            if index >= len(source):
                return False
            index += 1
            continue
        if source[index] == '(':
            inline_flags = _inline_flag_group(source, index, verbose_modes[-1])
            if inline_flags is not None:
                index, scoped, verbose = inline_flags
                if scoped:
                    depth += 1
                    verbose_modes.append(verbose)
                else:
                    verbose_modes[-1] = verbose
                continue
            depth += 1
            verbose_modes.append(verbose_modes[-1])
        elif source[index] == ')':
            if depth == 0:
                return False
            depth -= 1
            verbose_modes.pop()
        elif source[index] == '|' and depth == 0:
            return False
        index += 1
    return depth == 0


def _recognizes_authority_policy(pattern, canonical_url):
    """Recognize the documented fail-closed authority-policy source grammar.

    The grammar is an optional start anchor, a literal HTTP(S) scheme, either
    an exact host with an optional numeric-port policy or a whole-authority
    ``[^/]`` policy, and a proven authority boundary. Regex syntax is otherwise
    unrestricted only after that boundary.
    """
    source = pattern.pattern
    scheme_result = _take_literal_scheme(source)
    if scheme_result is None:
        return False
    source_scheme, position = scheme_result

    parsed = urlsplit(canonical_url)
    if parsed.scheme.lower() != source_scheme or not parsed.hostname or parsed.username is not None:
        return False

    if source.startswith('[^/]', position):
        quantifier_start = position + len('[^/]')
        quantifier = _take_positive_numeric_quantifier(source, quantifier_start)
        if quantifier is None or quantifier[0] == quantifier_start:
            return False
        position, minimum, maximum = quantifier
        authority_length = len(parsed.netloc)
        if authority_length < minimum or maximum is not None and authority_length > maximum:
            return False
    else:
        host_result = _take_exact_host(source, position)
        if host_result is None:
            return False
        source_host, position = host_result
        actual_host = f'[{parsed.hostname}]' if parsed.netloc.startswith('[') else parsed.hostname
        if source_host.lower() != actual_host.lower():
            return False
        port_result = _take_port_policy(source, position)
        if port_result is None:
            return False
        position, optional_port, port_policy = port_result
        if not _port_policy_matches(port_policy, optional_port, _explicit_port_text(parsed.netloc)):
            return False

    boundary = _take_authority_boundary(source, position)
    if boundary is None:
        return False
    boundary_end, uses_dollar, delimiters = boundary
    if uses_dollar and pattern.flags & re.MULTILINE:
        return False
    authority_end = len(parsed.scheme) + len('://') + len(parsed.netloc)
    actual_delimiter = canonical_url[authority_end : authority_end + 1]
    if actual_delimiter not in delimiters:
        return False
    return _tail_has_no_outer_alternation(source, boundary_end, pattern.flags)


def _pattern_matches_canonical_url(pattern, canonical_url):
    """Match the canonical URL, then prove the regex authority policy."""
    if not isinstance(pattern.pattern, str):
        return False

    match = _match(pattern, canonical_url)
    if match is None:
        return False
    return _recognizes_authority_policy(pattern, canonical_url)


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
                    'description': 'Path-only parameter replacements (e.g. {"id": "123"} replaces :id in the URL path)',
                    'additionalProperties': {'type': 'string'},
                },
                'auth': {
                    'type': 'object',
                    'description': 'Advanced auth config. Prefer bearer_token or basic_auth shortcuts instead.',
                    'properties': {
                        'type': {'type': 'string', 'enum': ['api_key', 'basic', 'bearer', 'none']},
                        'basic': {
                            'type': 'object',
                            'properties': {'username': {'type': 'string'}, 'password': {'type': 'string'}},
                        },
                        'bearer': {'type': 'object', 'properties': {'token': {'type': 'string'}}},
                        'api_key': {
                            'type': 'object',
                            'properties': {
                                'key': {'type': 'string'},
                                'value': {'type': 'string'},
                                'add_to': {'type': 'string', 'enum': ['header', 'query_param']},
                            },
                        },
                    },
                },
                'body': {
                    'type': 'object',
                    'description': 'Advanced body config. Prefer body_json shortcut for JSON payloads.',
                    'properties': {
                        'type': {'type': 'string', 'enum': ['form_data', 'none', 'raw', 'x_www_form_urlencoded']},
                        'raw': {
                            'type': 'object',
                            'properties': {
                                'content': {'type': 'string'},
                                'content_type': {
                                    'type': 'string',
                                    'enum': [
                                        'application/json',
                                        'application/xml',
                                        'text/html',
                                        'text/javascript',
                                        'text/plain',
                                    ],
                                },
                            },
                        },
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
            'Non-public network destinations are blocked, and redirects are returned without being followed. '
            'Optional: "headers", "query_params", "path_params", "timeout" (seconds, default 30, max 300).'
        ),
    )
    def http_request(self, args):
        """Make an HTTP request with security guardrails."""
        if not isinstance(args, dict):
            raise ValueError('Tool input must be a JSON object (dict)')

        # Expand convenience shortcuts into canonical form
        _normalize_shortcuts(args)

        # Resolve every URL-affecting option before whitelist matching. The
        # execution helper uses the same final-URL construction path.
        self._validate_guardrails(args)

        # Enforce rate limits before executing the request
        rate_limiter = self.IGlobal.rate_limiter
        if rate_limiter is not None:
            rate_limiter.acquire()

        try:
            return execute_request(
                url=args.get('url'),
                method=args.get('method', 'GET'),
                query_params=args.get('query_params'),
                path_params=args.get('path_params'),
                headers=args.get('headers'),
                auth=args.get('auth'),
                body=args.get('body'),
                timeout=args.get('timeout'),
            )
        finally:
            if rate_limiter is not None:
                rate_limiter.release()

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
            raise ValueError(
                f'HTTP method "{method.upper()}" is not allowed. Enabled methods: {", ".join(sorted(self.IGlobal.enabled_methods))}'
            )

        url = args.get('url')
        if not url or not isinstance(url, str):
            raise ValueError('url is required and must be a non-empty string')
        resolved_url = _build_final_url(
            url,
            path_params=args.get('path_params'),
            query_params=args.get('query_params'),
            auth=args.get('auth'),
        )
        if self.IGlobal.url_patterns and not any(
            _pattern_matches_canonical_url(pattern, resolved_url) for pattern in self.IGlobal.url_patterns
        ):
            raise ValueError('URL does not match any allowed URL pattern.')

        auth = args.get('auth')
        if auth is not None:
            if not isinstance(auth, dict):
                raise ValueError('auth must be a JSON object')
            auth_type_val = auth.get('type', 'none')
            if not isinstance(auth_type_val, str):
                raise ValueError('auth.type must be a string')
            auth_type = auth_type_val.strip().lower()
            if auth_type not in valid_auth_types:
                raise ValueError(f'auth.type must be one of {sorted(valid_auth_types)}; got {auth_type!r}')
            if auth_type == 'basic':
                basic = auth.get('basic')
                if not isinstance(basic, dict):
                    raise ValueError('auth.basic must be a JSON object with username and password')

        body = args.get('body')
        if body is not None:
            if not isinstance(body, dict):
                raise ValueError('body must be a JSON object')
            body_type_val = body.get('type', 'none')
            if not isinstance(body_type_val, str):
                raise ValueError('body.type must be a string')
            body_type = body_type_val.strip().lower()
            if body_type not in valid_body_types:
                raise ValueError(f'body.type must be one of {sorted(valid_body_types)}; got {body_type!r}')
            if body_type == 'raw':
                raw = body.get('raw')
                if not isinstance(raw, dict):
                    raise ValueError('body.raw must be a JSON object')
                ct_val = raw.get('content_type', 'application/json')
                if not isinstance(ct_val, str):
                    raise ValueError('body.raw.content_type must be a string')
                ct = ct_val.strip().lower()
                if ct not in valid_raw_content_types:
                    raise ValueError(
                        f'body.raw.content_type must be one of {sorted(valid_raw_content_types)}; got {ct!r}'
                    )

        return resolved_url


def _normalize_shortcuts(args):
    """Expand convenience shortcuts (body_json, bearer_token, basic_auth) into canonical form."""
    body_json = args.pop('body_json', None)
    if body_json is not None and not args.get('body'):
        content_str = (
            json.dumps(body_json)
            if isinstance(body_json, (dict, list))
            else body_json
            if isinstance(body_json, str)
            else json.dumps(body_json)
        )
        args['body'] = {'type': 'raw', 'raw': {'content': content_str, 'content_type': 'application/json'}}

    bearer_token = args.pop('bearer_token', None)
    if bearer_token is not None and not args.get('auth'):
        args['auth'] = {'type': 'bearer', 'bearer': {'token': str(bearer_token)}}

    basic_auth = args.pop('basic_auth', None)
    if isinstance(basic_auth, dict) and not args.get('auth'):
        args['auth'] = {'type': 'basic', 'basic': basic_auth}
