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
HTTP request execution engine.

Accepts a fully-specified request descriptor (URL, method, headers, auth, body,
params) and returns a structured response dict.  Uses the ``requests`` library.
"""

from __future__ import annotations

import re
import time
from typing import Any, Dict, List, Optional
from urllib.parse import urlparse, urlunparse

import requests
from requests.auth import HTTPBasicAuth

from library.ssrf_protection import SSRFError, validate_url

DEFAULT_TIMEOUT_SECONDS = 30
MAX_TIMEOUT_SECONDS = 300
MAX_REDIRECTS = 10


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
    ssrf_allowed_private: Optional[List[str]] = None,
) -> Dict[str, Any]:
    """Execute an HTTP request and return a structured response.

    Parameters
    ----------
    ssrf_allowed_private:
        Optional list of CIDR strings that should be permitted even though
        they fall within normally-blocked private/reserved IP ranges.

    Raises ``requests.RequestException`` on transport-level failures and
    ``SSRFError`` if the URL targets a blocked IP range.
    """
    resolved_url = _resolve_path_params(url, path_params)

    # --- SSRF protection: validate and resolve DNS once ---
    # Returns (url, hostname, resolved_ips) so we can pin the connection
    # to the validated IP, preventing TOCTOU DNS rebinding attacks.
    _validated_url, original_hostname, resolved_ips = validate_url(resolved_url, allowed_private=ssrf_allowed_private)

    req_headers = dict(headers or {})
    req_auth = None
    extra_params: Dict[str, str] = {}

    _apply_auth(auth, req_headers, extra_params, req_auth_out := [None])
    req_auth = req_auth_out[0]

    merged_params = dict(query_params or {})
    merged_params.update(extra_params)

    # Pin connection to the validated IP to prevent TOCTOU DNS rebinding.
    pinned_url = _pin_url_to_ip(resolved_url, original_hostname, resolved_ips[0])
    req_headers.setdefault('Host', original_hostname)

    req_kwargs: Dict[str, Any] = {
        'method': method.upper(),
        'url': pinned_url,
        'headers': req_headers,
        'params': merged_params or None,
        'auth': req_auth,
        'allow_redirects': False,  # Handle redirects manually for SSRF safety
    }

    _apply_body(body, req_headers, req_kwargs)

    effective_timeout = min(timeout, MAX_TIMEOUT_SECONDS) if timeout is not None and timeout > 0 else DEFAULT_TIMEOUT_SECONDS
    req_kwargs['timeout'] = effective_timeout

    start = time.monotonic()
    resp = requests.request(**req_kwargs)

    # --- Manual redirect loop: validate each Location before following ---
    redirects_followed = 0
    while resp.is_redirect and redirects_followed < MAX_REDIRECTS:
        location = resp.headers.get('Location')
        if not location:
            break

        # Resolve relative redirects against the current URL
        if not location.startswith(('http://', 'https://')):
            parsed_current = urlparse(req_kwargs['url'])
            location = urlunparse((parsed_current.scheme, parsed_current.netloc, location, '', '', ''))

        # Validate the redirect target against SSRF rules
        _redirect_url, redirect_hostname, redirect_ips = validate_url(location, allowed_private=ssrf_allowed_private)

        # Pin the redirect to its validated IP as well
        pinned_redirect = _pin_url_to_ip(location, redirect_hostname, redirect_ips[0])
        redirect_headers = dict(req_headers)
        redirect_headers['Host'] = redirect_hostname

        req_kwargs = {
            'method': 'GET',  # Redirects always become GET (per HTTP spec for 301/302/303)
            'url': pinned_redirect,
            'headers': redirect_headers,
            'params': None,
            'auth': req_auth,
            'allow_redirects': False,
            'timeout': effective_timeout,
        }

        resp = requests.request(**req_kwargs)
        redirects_followed += 1

    if resp.is_redirect and redirects_followed >= MAX_REDIRECTS:
        raise SSRFError(f'SSRF protection: too many redirects (>{MAX_REDIRECTS}).')

    elapsed_ms = round((time.monotonic() - start) * 1000)

    return _build_response(resp, elapsed_ms)


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _pin_url_to_ip(url: str, hostname: str, ip: str) -> str:
    """Replace the hostname in *url* with *ip* to pin the connection.

    For IPv6 addresses the IP is wrapped in brackets as required by URL syntax.
    """
    parsed = urlparse(url)
    # Wrap IPv6 addresses in brackets
    ip_host = f'[{ip}]' if ':' in ip else ip
    # Preserve the port if one was explicitly specified
    if parsed.port:
        new_netloc = f'{ip_host}:{parsed.port}'
    else:
        new_netloc = ip_host
    return urlunparse((parsed.scheme, new_netloc, parsed.path, parsed.params, parsed.query, parsed.fragment))


def _resolve_path_params(url: str, path_params: Optional[Dict[str, str]]) -> str:
    """Replace ``:name`` placeholders in the URL with values from *path_params*."""
    if not path_params:
        return url
    resolved = url
    for key, value in path_params.items():
        resolved = re.sub(rf':{re.escape(key)}\b', str(value), resolved)
    return resolved


def _apply_auth(
    auth: Optional[Dict[str, Any]],
    headers: Dict[str, str],
    extra_params: Dict[str, str],
    req_auth_out: list,
) -> None:
    """Mutate *headers* / *extra_params* / *req_auth_out* based on auth config."""
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
        if add_to == 'query_param':
            extra_params[key] = value
        else:
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
