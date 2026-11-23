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
Supabase Edge Functions tool: ``invoke_function``.

The call goes to ``<project url>/functions/v1/<name>`` through the shared
``SupabaseApi`` helper rather than ``client.functions.invoke``: supabase-py
returns only the body (not the HTTP status) on success, and it lets
caller-supplied headers replace ``Authorization``. Here the secret key is
always sent as ``apikey`` and ``Authorization: Bearer``, and the caller can
never set those headers.

The new ``sb_secret_`` keys are not JWTs. A function deployed with
"Verify JWT" on rejects them with HTTP 401 from the gateway; that answer is
turned into an error that says how to fix it. A 401 the function itself
returns (its own login check) is an answer and comes back with ok false.

The response is streamed and read only up to Max response size, so a large
or endless body never fills the engine's memory.
"""

from __future__ import annotations

import re
from typing import Any, Dict, Optional, Tuple

from ai.common.utils import optional_str, require_str
from rocketlib import tool_function

from .. import supabase_client as sc
from ..IInstance import WRITE, SupabaseInstanceBase, requires_access
from .IGlobal import IGlobal

FUNCTIONS_PATH = '/functions/v1/'
METHODS = ('POST', 'GET', 'PUT', 'PATCH', 'DELETE')
DEFAULT_METHOD = 'POST'
_NO_BODY_METHODS = ('GET',)

# Supabase function names (slugs): a letter first, then letters, digits, '_' or '-'.
# The check also keeps the name from adding path segments ("../rest/v1").
_FUNCTION_NAME = re.compile(r'^[A-Za-z][A-Za-z0-9_-]{0,127}$')

# Headers the caller may not set. Authorization and apikey carry the secret
# key; the rest are framing headers httpx computes (a wrong value would
# corrupt the request).
RESERVED_HEADERS = frozenset(
    {'authorization', 'apikey', 'host', 'content-length', 'transfer-encoding', 'connection', 'cookie'}
)
_HEADER_NAME = re.compile(r"^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$")
MAX_HEADERS = 20
MAX_HEADER_VALUE = 4096

# The gateway's JWT refusals: the edge runtime's codes (UNAUTHORIZED_NO_AUTH_HEADER,
# UNAUTHORIZED_INVALID_JWT_FORMAT, ...) and the legacy body {"msg": "Invalid JWT"}.
_GATEWAY_CODE_PREFIX = 'UNAUTHORIZED_'
_GATEWAY_LEGACY_BODY = {'msg': 'Invalid JWT'}

_TEXT_TYPES = ('json', 'xml', 'javascript', 'x-www-form-urlencoded', 'csv', 'yaml')

VERIFY_JWT_HINT = (
    'Supabase secret keys (sb_secret_...) are not JWTs, so a function with JWT verification on refuses them. '
    'Turn JWT verification off for this function (its Verify JWT setting in the dashboard, verify_jwt = false '
    'in supabase/config.toml, or deploy with --no-verify-jwt) and check the apikey header inside the function.'
)


class IInstance(SupabaseInstanceBase):
    """Agent tool that calls one of the project's Edge Functions."""

    IGlobal: IGlobal

    @tool_function(
        input_schema={
            'type': 'object',
            'properties': {
                'name': {
                    'type': 'string',
                    'description': 'Name (slug) of the deployed Edge Function, e.g. "hello-world".',
                },
                'body': {
                    'description': (
                        'Request body. An object, array, number or boolean is sent as JSON; a string is sent as '
                        'text/plain. Omit for no body. Not allowed with GET.'
                    )
                },
                'method': {'type': 'string', 'enum': list(METHODS), 'description': 'HTTP method. Default POST.'},
                'headers': {
                    'type': 'object',
                    'additionalProperties': {'type': 'string'},
                    'description': (
                        f'Extra request headers (at most {MAX_HEADERS}), e.g. {{"x-request-id": "42"}}. '
                        'Authorization, apikey, Host, Cookie, Content-Length, Transfer-Encoding and Connection '
                        'cannot be set.'
                    ),
                },
            },
            'required': ['name'],
        },
        output_schema={
            'type': 'object',
            'properties': {
                'name': {'type': 'string'},
                'status': {'type': 'integer', 'description': 'HTTP status the function answered with.'},
                'ok': {'type': 'boolean', 'description': 'True for a 2xx status.'},
                'content_type': {'type': 'string'},
                'body': {
                    'description': 'Parsed JSON, or text. Null when the function returned no body or binary content.'
                },
                'body_bytes': {
                    'type': 'integer',
                    'description': (
                        'Size of the response body in bytes, as the function sent it. Absent when the body was '
                        'cut and the function did not send its length.'
                    ),
                },
                'truncated': {
                    'type': 'boolean',
                    'description': 'True when body was cut to the size limit (then body is text).',
                },
                'note': {'type': 'string'},
            },
        },
        description=(
            "Call one of the Supabase project's Edge Functions over HTTPS and return its answer. "
            'Arguments: name, body (optional JSON or text), method (optional, POST by default; GET, PUT, PATCH, '
            'DELETE), headers (optional object of extra headers). Needs the write access level. Returns name, '
            'status, ok, content_type, body (parsed JSON or text) and body_bytes. A function error (4xx/5xx, '
            "including its own 401) is returned with ok false, not raised. The body is cut to the node's Max "
            'response size; then truncated is true and body holds the first part as text. Binary answers are not '
            'returned (body is null and note says why). The function must accept the secret key: functions with '
            '"Verify JWT" on refuse it.'
        ),
    )
    @requires_access(WRITE)
    def invoke_function(self, args: Dict[str, Any]) -> Dict[str, Any]:
        """Call <project url>/functions/v1/<name> and return its status and (capped) body."""
        tool = self._tool('invoke_function')
        name = require_str(args, 'name', tool_name=tool)
        if not _FUNCTION_NAME.fullmatch(name):
            raise ValueError(
                f'{tool}: "name" must be the function slug: a letter, then letters, digits, "_" or "-" '
                f'(at most 128 characters), got {name!r}'
            )
        method = (optional_str(args, 'method', default='', tool_name=tool).strip().upper()) or DEFAULT_METHOD
        if method not in METHODS:
            raise ValueError(f'{tool}: "method" must be one of {list(METHODS)}, got {args.get("method")!r}')
        headers = _caller_headers(args.get('headers'), tool)
        json_body, content, content_type = self._body(args.get('body'), method, tool)
        if content_type and not any(k.lower() == 'content-type' for k in headers):
            headers['Content-Type'] = content_type

        result = self._api().request(
            method,
            FUNCTIONS_PATH + name,
            json=json_body,
            content=content,
            headers=headers,
            timeout=self.IGlobal.timeout_seconds,
            # A function's own 4xx/5xx is an answer the agent should see, not an exception.
            raise_for_status=False,
            what=f'Edge Function {name!r}',
            # Read at most this much: Max response size bounds memory, not only the answer.
            max_bytes=self.IGlobal.max_response_kb * 1024,
        )
        _raise_for_gateway(result, name)
        return self._shape(name, result)

    # ------------------------------------------------------------------
    # Request / response shaping
    # ------------------------------------------------------------------

    def _body(self, body: Any, method: str, tool_name: str) -> Tuple[Any, Optional[bytes], Optional[str]]:
        """Return (json, content, content type for a text body); refuse a body above Max request size."""
        if body is None:
            return None, None, None
        if method in _NO_BODY_METHODS:
            raise ValueError(f'{tool_name}: a GET request cannot have a body; use POST or omit "body"')
        if isinstance(body, str):
            # A text body is sent as its UTF-8 bytes, so those are what the limit measures.
            raw = body.encode('utf-8')
            if len(raw) > self.IGlobal.max_request_kb * 1024:
                raise ValueError(
                    f'{tool_name}: "body" is {len(raw)} bytes; the limit is {self.IGlobal.max_request_kb} KB '
                    '(Max request size on the node)'
                )
            return None, raw, 'text/plain; charset=utf-8'
        self._check_json_size(
            body, 'body', tool_name=tool_name, limit_kb=self.IGlobal.max_request_kb, setting='Max request size'
        )
        # httpx sets application/json itself for a json= body.
        return body, None, None

    def _shape(self, name: str, result: sc.HttpResult) -> Dict[str, Any]:
        content_type = result.headers.get('content-type', '')
        out: Dict[str, Any] = {'name': name, 'status': result.status, 'ok': result.ok, 'content_type': content_type}
        # The size Supabase sent (raw bytes), not a re-serialised copy. Unknown
        # only when the body was cut and the server sent no Content-Length.
        if result.size is not None:
            out['body_bytes'] = result.size
        if not result.content:
            out.update(body=None, body_bytes=0, truncated=False)
            return out
        if not _is_textual(content_type):
            # SupabaseApi decodes every body as UTF-8; for images, PDFs and the like that text is noise.
            out.update(
                body=None, truncated=False, note=f'Binary content ({content_type or "unknown type"}) is not returned.'
            )
            return out
        if result.truncated:
            # result.body is the text of the first Max response size bytes, never parsed.
            out.update(body=result.body, truncated=True)
            out['note'] = f'Body cut to the first {self.IGlobal.max_response_kb} KB (Max response size on the node).'
            return out
        out.update(body=result.body, truncated=False)
        return out


def _is_textual(content_type: str) -> bool:
    """True for text/* and the structured text types; a missing type counts as text."""
    ct = content_type.lower()
    return not ct or ct.startswith('text/') or any(t in ct for t in _TEXT_TYPES)


def _caller_headers(raw: Any, tool_name: str) -> Dict[str, str]:
    """Validate the caller's extra headers. Reserved headers are refused, never merged."""
    if raw is None:
        return {}
    if not isinstance(raw, dict):
        raise ValueError(f'{tool_name}: "headers" must be a JSON object of header name -> string value')
    if len(raw) > MAX_HEADERS:
        raise ValueError(f'{tool_name}: at most {MAX_HEADERS} headers are allowed, got {len(raw)}')
    out: Dict[str, str] = {}
    for key, value in raw.items():
        if not isinstance(key, str) or not _HEADER_NAME.fullmatch(key):
            raise ValueError(f'{tool_name}: {key!r} is not a valid header name')
        if key.lower() in RESERVED_HEADERS:
            raise ValueError(
                f'{tool_name}: the {key!r} header cannot be set; the node sends its own credentials and framing headers'
            )
        if not isinstance(value, str):
            raise ValueError(f'{tool_name}: header {key!r} must have a string value')
        if len(value) > MAX_HEADER_VALUE or '\r' in value or '\n' in value:
            raise ValueError(f'{tool_name}: header {key!r} must be one line of at most {MAX_HEADER_VALUE} characters')
        out[key] = value
    return out


def _is_gateway_jwt_refusal(body: Any) -> bool:
    """True for the body the Edge Functions gateway sends when Verify JWT refuses a call.

    The gateway answers {"code": "UNAUTHORIZED_<reason>", "message": ...}
    (older versions: exactly {"msg": "Invalid JWT"}). Anything else, such as
    {"message": "Invalid token"} or {"code": "UNAUTHORIZED"}, is the function's
    own 401 and is passed back to the agent. The gateway never says "Missing
    authorization header" to this node, which always sends Authorization.
    """
    if not isinstance(body, dict):
        return False
    code = body.get('code')
    if isinstance(code, str) and code.startswith(_GATEWAY_CODE_PREFIX):
        return True
    # Exactly the legacy body: a function that answers {"message": "Invalid JWT"}
    # or {"msg": "Invalid JWT", "detail": ...} wrote it itself, and the agent sees it.
    return body == _GATEWAY_LEGACY_BODY


def _raise_for_gateway(result: sc.HttpResult, name: str) -> None:
    """Turn the gateway's own refusals into clear errors; the function's answers pass through.

    401 with the gateway's body: it refused the secret key, almost always
    because "Verify JWT" is on. 404 with code NOT_FOUND: no function with that
    name is deployed. A function's own 401 or 404 has its own body and is
    returned with ok false.
    """
    detail = sc.error_message_from_body(result.body) or 'no details'
    if result.status == 401 and _is_gateway_jwt_refusal(result.body):
        raise sc.SupabaseError(
            f'Edge Function {name!r} refused the secret key (HTTP 401): {detail}. {VERIFY_JWT_HINT}', status=401
        )
    if result.status == 404 and isinstance(result.body, dict) and result.body.get('code') == 'NOT_FOUND':
        raise sc.SupabaseError(
            f'No Edge Function named {name!r} is deployed in this project (HTTP 404). '
            'Check the name under Edge Functions in the dashboard.',
            status=404,
        )
