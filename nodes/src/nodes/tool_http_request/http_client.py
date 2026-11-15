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
HTTP request execution engine.

Accepts a fully-specified request descriptor (URL, method, headers, auth, body,
params) and returns a structured response dict.  Uses the ``requests`` library.
"""

from __future__ import annotations

import re
import time
from typing import Any, Dict, Optional
from urllib.parse import quote, unquote, urlsplit

import requests
from requests.auth import HTTPBasicAuth

from ai.common.utils import HostResolutionError, pinned_session, resolve_public_addresses

DEFAULT_TIMEOUT_SECONDS = 30
MAX_TIMEOUT_SECONDS = 300

# (family, socktype, proto, sockaddr) from ai.common.utils.resolve_public_addresses.
ResolvedAddress = tuple[int, int, int, tuple]


def execute_request(
    *,
    url: str,
    method: str,
    query_params: Optional[Dict[str, str]] = None,
    path_params: Optional[Dict[str, str]] = None,
    headers: Optional[Dict[str, str]] = None,
    auth: Optional[Dict[str, Any]] = None,
    body: Optional[Dict[str, Any]] = None,
    timeout: Optional[float] = None,
) -> Dict[str, Any]:
    """Execute an HTTP request and return a structured response.

    Raises ``requests.RequestException`` on transport-level failures.
    """
    start = time.monotonic()
    resolved_url = _build_final_url(url, path_params=path_params, query_params=query_params, auth=auth)
    validated_addresses = _validate_public_url(resolved_url)

    req_headers = dict(headers or {})
    req_auth = None

    _apply_auth(auth, req_headers, req_auth_out := [None])
    req_auth = req_auth_out[0]

    if any(name.lower() == 'host' for name in req_headers):
        raise ValueError('The Host header is derived from the validated URL and cannot be overridden')

    req_kwargs: Dict[str, Any] = {
        'method': method.upper(),
        'url': resolved_url,
        'headers': req_headers,
        'params': None,
        'auth': req_auth,
        # Redirect targets have not passed the URL whitelist or network-address
        # checks. Return 3xx responses to the caller instead of following them.
        'allow_redirects': False,
    }

    _apply_body(body, req_headers, req_kwargs)

    if timeout is not None and timeout > 0:
        req_kwargs['timeout'] = min(timeout, MAX_TIMEOUT_SECONDS)
    else:
        req_kwargs['timeout'] = DEFAULT_TIMEOUT_SECONDS

    transport_error = None
    try:
        resp = _request_with_validated_addresses(req_kwargs, validated_addresses)
    except requests.RequestException as error:
        transport_error = _sanitize_transport_error(error)
    if transport_error is not None:
        raise transport_error
    elapsed_ms = round((time.monotonic() - start) * 1000)

    return _build_response(resp, elapsed_ms)


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _request_with_validated_addresses(req_kwargs: Dict[str, Any], addresses: tuple[ResolvedAddress, ...]):
    """Execute one request using only the DNS addresses already validated.

    The shared pinned session ignores environment proxies and ``.netrc``,
    keeps a custom CA bundle, and connects only to ``addresses``.
    """
    with pinned_session(addresses) as session:
        return session.request(**req_kwargs)


def _sanitize_transport_error(error: requests.RequestException) -> requests.RequestException:
    """Return a same-type transport error without request URL state."""
    try:
        return type(error)('HTTP request failed')
    except TypeError:
        return requests.RequestException('HTTP request failed')


def _validate_public_url(url: str) -> tuple[ResolvedAddress, ...]:
    """Reject malformed URLs and destinations outside the public Internet."""
    parsed = urlsplit(url)
    _reject_url_userinfo(parsed)
    if parsed.scheme.lower() not in {'http', 'https'}:
        raise ValueError('URL scheme must be http or https')
    if not parsed.hostname:
        raise ValueError('URL must include a hostname')

    if _url_has_dot_segments(url):
        raise ValueError('URL path must not contain dot segments')

    try:
        port = parsed.port
    except ValueError:
        raise ValueError('URL port is invalid') from None
    if port == 0:
        raise ValueError('URL port is invalid')

    try:
        return resolve_public_addresses(url)
    except HostResolutionError as error:
        # A DNS failure is a transport error, not a policy rejection.
        raise requests.ConnectionError(str(error)) from None


def _url_has_dot_segments(url: str) -> bool:
    """Detect traversal segments; fail closed on excessive encoding layers."""
    path = urlsplit(url).path
    for _decode_attempt in range(5):
        normalized_separators = path.replace('\\', '/')
        if any(segment in {'.', '..'} for segment in normalized_separators.split('/')):
            return True
        decoded = unquote(path)
        if decoded == path:
            return False
        path = decoded
    return True


def _canonicalize_url(url: str) -> str:
    """Return the stable URL form Requests will put on the wire."""
    # Fragments are client-side only and HTTPAdapter removes them from the
    # request target, so they must not influence whitelist matching.
    parsed = urlsplit(url)
    _reject_url_userinfo(parsed)
    prepared_url = parsed._replace(fragment='').geturl()
    for _attempt in range(3):
        if _url_has_dot_segments(prepared_url):
            raise ValueError('URL path must not contain dot segments')
        normalized_url = requests.Request('GET', prepared_url).prepare().url
        if normalized_url == prepared_url:
            return normalized_url
        prepared_url = normalized_url
    raise ValueError('URL normalization did not stabilize')


def _reject_url_userinfo(parsed) -> None:
    """Reject URL credentials so they cannot alter the validated destination."""
    if parsed.username is not None:
        raise ValueError('URL must not include userinfo')


def _resolve_path_params(url: str, path_params: Optional[Dict[str, str]]) -> str:
    """Replace ``:name`` placeholders in the URL path with literal segments."""
    if not path_params:
        return url
    parsed = urlsplit(url)
    resolved_path = parsed.path
    for key, value in path_params.items():
        if str(value) in {'.', '..'}:
            raise ValueError('Path parameter values cannot be dot segments')
        # Encode (safe='') so the value stays one path segment and cannot slip
        # past the final URL allowlist. The function replacement keeps it
        # literal (no re.sub backslash/group-ref interpretation, e.g. '\1' ->
        # re.error). Only the parsed path is eligible for substitution, so a
        # parameter cannot replace the URL's scheme, hostname, port, or query.
        replacement = quote(str(value), safe='')
        resolved_path = re.sub(rf':{re.escape(key)}\b', lambda _m, r=replacement: r, resolved_path)
    return parsed._replace(path=resolved_path).geturl()


def _build_final_url(
    url: str,
    *,
    path_params: Optional[Dict[str, str]] = None,
    query_params: Optional[Dict[str, str]] = None,
    auth: Optional[Dict[str, Any]] = None,
) -> str:
    """Return the canonical URL after every URL-affecting request option."""
    resolved_url = _canonicalize_url(_resolve_path_params(url, path_params))
    merged_params = dict(query_params or {})
    merged_params.update(_api_key_query_params(auth))
    if not merged_params:
        return resolved_url
    prepared_url = requests.Request('GET', resolved_url, params=merged_params).prepare().url
    return _canonicalize_url(prepared_url)


def _api_key_query_params(auth: Optional[Dict[str, Any]]) -> Dict[str, str]:
    """Extract query-based API-key auth for final URL construction."""
    if not isinstance(auth, dict):
        return {}
    auth_type = auth.get('type') or 'none'
    if not isinstance(auth_type, str) or auth_type.strip().lower() != 'api_key':
        return {}
    api_key = auth.get('api_key') or {}
    if not isinstance(api_key, dict):
        return {}
    add_to = api_key.get('add_to') or 'header'
    if not isinstance(add_to, str) or add_to.strip().lower() != 'query_param':
        return {}
    return {api_key.get('key', ''): api_key.get('value', '')}


def _apply_auth(
    auth: Optional[Dict[str, Any]],
    headers: Dict[str, str],
    req_auth_out: list,
) -> None:
    """Mutate *headers* / *req_auth_out* based on auth config."""
    if not auth:
        return
    auth_type = (auth.get('type') or 'none').strip().lower()
    if auth_type == 'none':
        return

    if auth_type == 'basic':
        basic = auth.get('basic') or {}
        req_auth_out[0] = HTTPBasicAuth(
            basic.get('username', ''),
            basic.get('password', ''),
        )

    elif auth_type == 'bearer':
        bearer = auth.get('bearer') or {}
        token = bearer.get('token', '')
        headers['Authorization'] = f'Bearer {token}'

    elif auth_type == 'api_key':
        api_key = auth.get('api_key') or {}
        key = api_key.get('key', '')
        value = api_key.get('value', '')
        add_to = (api_key.get('add_to') or 'header').strip().lower()
        if add_to != 'query_param':
            headers[key] = value


def _apply_body(
    body: Optional[Dict[str, Any]],
    headers: Dict[str, str],
    req_kwargs: Dict[str, Any],
) -> None:
    """Populate *req_kwargs* with the appropriate body payload."""
    if not body:
        return
    body_type = (body.get('type') or 'none').strip().lower()
    if body_type == 'none':
        return

    if body_type == 'raw':
        raw = body.get('raw') or {}
        content = raw.get('content', '')
        content_type = raw.get('content_type', 'application/json')
        headers.setdefault('Content-Type', content_type)
        req_kwargs['data'] = content

    elif body_type == 'form_data':
        form_data = body.get('form_data') or {}
        # multipart/form-data: pass each field as a tuple so ``requests``
        # builds the multipart envelope automatically.
        req_kwargs['files'] = {k: (None, v) for k, v in form_data.items()}

    elif body_type == 'x_www_form_urlencoded':
        urlencoded = body.get('urlencoded') or {}
        req_kwargs['data'] = urlencoded


def _build_response(resp: requests.Response, elapsed_ms: int) -> Dict[str, Any]:
    """Convert a ``requests.Response`` into a structured dict for the agent."""
    content_type = resp.headers.get('Content-Type', '')

    parsed_json = None
    if 'json' in content_type or 'javascript' in content_type:
        try:
            parsed_json = resp.json()
        except Exception:
            pass

    return {
        'status_code': resp.status_code,
        'status_text': resp.reason or '',
        'headers': dict(resp.headers),
        'body': resp.text,
        'json': parsed_json,
        'elapsed_ms': elapsed_ms,
        'content_type': content_type,
    }
