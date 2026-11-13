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

"""Shared Auth0 client and configuration validation."""

import re
import math
import threading
import time
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from urllib.parse import quote


class Auth0Error(ValueError):
    """A safe, structured error for the calling tool."""

    def __init__(self, code, message, *, retryable=False, retry_after_seconds=None):
        """Record a safe error and optional retry details."""
        super().__init__(message)
        self.code = code
        self.retryable = retryable
        self.retry_after_seconds = retry_after_seconds


def _retry_after(headers):
    """Parse a retry delay from response headers."""
    value = headers.get('Retry-After')
    if not value:
        value = headers.get('x-ratelimit-reset')
        if not value:
            return 0.0
        try:
            delay = float(value) - time.time()
        except (TypeError, ValueError, OverflowError):
            return 0.0
        return max(0.0, delay) if math.isfinite(delay) else 0.0
    try:
        delay = float(value)
    except (TypeError, ValueError):
        try:
            date = parsedate_to_datetime(value)
            if date.tzinfo is None:
                return 0.0
            delay = (date - datetime.now(timezone.utc)).total_seconds()
        except (TypeError, ValueError, OverflowError):
            return 0.0
    return max(0.0, delay) if math.isfinite(delay) else 0.0


def validate_domain(domain):
    """Accept only ASCII DNS hostnames below auth0.com."""
    if not isinstance(domain, str):
        raise Auth0Error('INVALID_DOMAIN', 'A valid Auth0 tenant hostname is required.')
    domain = re.sub(r'^https://', '', domain.strip(), flags=re.IGNORECASE).removesuffix('/').lower()
    if len(domain) > 253 or not domain.endswith('.auth0.com'):
        raise Auth0Error('INVALID_DOMAIN', 'A valid Auth0 tenant hostname is required.')
    labels = domain.split('.')
    if len(labels) < 3 or any(
        not re.fullmatch(r'[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?', label) for label in labels
    ):
        raise Auth0Error('INVALID_DOMAIN', 'A valid Auth0 tenant hostname is required.')
    return domain.lower()


def validate_config(cfg: dict) -> None:
    """Reject incomplete credentials without including values in errors."""
    for key in ('domain', 'clientId', 'clientSecret'):
        if not isinstance(cfg.get(key), str) or not cfg[key].strip():
            raise ValueError(f'Auth0: {key} is required')
    validate_domain(cfg['domain'])
    allow_write = cfg.get('allowWrite', False)
    if not isinstance(allow_write, bool):
        raise ValueError('Auth0: allowWrite must be a boolean')
    if allow_write:
        for key in ('writeClientId', 'writeClientSecret'):
            if not isinstance(cfg.get(key), str) or not cfg[key].strip():
                raise ValueError(f'Auth0: {key} is required when writes are enabled')
        if cfg['writeClientId'].strip() == cfg['clientId'].strip():
            raise ValueError('Auth0: read and write client IDs must belong to separate applications')
    keys = ('clientId', 'clientSecret')
    if allow_write:
        keys += ('writeClientId', 'writeClientSecret')
    for key in keys:
        if re.search(r'\$\{[^}]*\}|<REDACTED>', cfg[key]):
            raise ValueError(f'Auth0: {key} contains an unresolved credential reference')


class Auth0Client:
    """Own credentials, independent token caches, and fixed Management API routes."""

    def __init__(self, cfg: dict) -> None:
        """Validate credentials and initialize independent token caches."""
        validate_config(cfg)
        keys = ['domain', 'clientId', 'clientSecret', 'allowWrite']
        if cfg.get('allowWrite', False):
            keys.extend(('writeClientId', 'writeClientSecret'))
        self._config = {key: cfg.get(key) for key in keys}
        self._base = 'https://' + validate_domain(cfg['domain'])
        self._tokens = {'read': None, 'write': None}
        self._locks = {'read': threading.Lock(), 'write': threading.Lock()}
        self._closed = False

    def close(self) -> None:
        """Release credential references."""
        with self._locks['read'], self._locks['write']:
            self._closed = True
            self._config.clear()
            self._tokens = {'read': None, 'write': None}

    @property
    def writes_enabled(self):
        """Report whether a separate write application is configured."""
        return self._config.get('allowWrite') is True

    def _token(self, kind):
        """Get or refresh the cached token for the credential kind."""
        import requests

        with self._locks[kind]:
            if self._closed:
                raise Auth0Error('CLIENT_CLOSED', 'Auth0 client is closed.')
            cached = self._tokens[kind]
            if cached and time.monotonic() < cached[1]:
                return cached[0]
            prefix = 'writeClient' if kind == 'write' else 'client'
            try:
                response = requests.post(
                    self._base + '/oauth/token',
                    json={
                        'grant_type': 'client_credentials',
                        'client_id': self._config[prefix + 'Id'],
                        'client_secret': self._config[prefix + 'Secret'],
                        'audience': self._base + '/api/v2/',
                    },
                    timeout=(5, 15),
                    allow_redirects=False,
                )
            except requests.exceptions.RequestException:
                raise Auth0Error('AUTH0_UNAVAILABLE', 'Auth0 could not be reached.', retryable=True) from None
            if not 200 <= response.status_code < 300:
                if response.status_code == 429:
                    raise Auth0Error(
                        'RATE_LIMITED',
                        'Auth0 rate limit reached.',
                        retryable=True,
                        retry_after_seconds=_retry_after(response.headers) or None,
                    )
                if response.status_code >= 500:
                    raise Auth0Error('AUTH0_UNAVAILABLE', 'Auth0 is unavailable.', retryable=True)
                raise Auth0Error('AUTHENTICATION_FAILED', 'Auth0 authentication failed.')
            try:
                data = response.json()
                token = data['access_token']
                expires = data['expires_in']
                if (
                    not isinstance(token, str)
                    or not token
                    or isinstance(expires, bool)
                    or not isinstance(expires, (int, float))
                    or not 0 < expires < 10**9
                ):
                    raise ValueError
            except (ValueError, TypeError, KeyError):
                raise Auth0Error('AUTHENTICATION_FAILED', 'Auth0 returned an invalid token response.') from None
            self._tokens[kind] = (token, time.monotonic() + max(0, expires - min(60, expires * 0.1)))
            return token

    def _invalidate(self, kind, token):
        """Discard a cached token if it matches the rejected token."""
        with self._locks[kind]:
            if self._tokens[kind] and self._tokens[kind][0] == token:
                self._tokens[kind] = None

    def request(self, operation, *, identifier=None, params=None):
        """Call an approved route. Writes are never automatically replayed."""
        import requests

        routes = {
            'search_users': ('GET', '/users'),
            'list_users': ('GET', '/users'),
            'list_applications': ('GET', '/clients'),
            'search_logs': ('GET', '/logs'),
            'get_brute_force_settings': ('GET', '/attack-protection/brute-force-protection'),
            'get_ip_throttling_settings': ('GET', '/attack-protection/suspicious-ip-throttling'),
            'get_user': ('GET', '/users/{id}'),
            'get_user_logs': ('GET', '/users/{id}/logs'),
            'get_log_event': ('GET', '/logs/{id}'),
            'get_user_blocks': ('GET', '/user-blocks/{id}'),
            'get_connection': ('GET', '/connections/{id}'),
            'get_connection_clients': ('GET', '/connections/{id}/clients'),
            'list_connections': ('GET', '/connections'),
            'list_roles': ('GET', '/roles'),
            'get_user_roles': ('GET', '/users/{id}/roles'),
            'get_user_permissions': ('GET', '/users/{id}/permissions'),
            'list_organizations': ('GET', '/organizations'),
            'get_organization_members': ('GET', '/organizations/{id}/members'),
            'unblock_user': ('DELETE', '/user-blocks/{id}'),
        }
        if operation not in routes:
            raise Auth0Error('INVALID_INPUT', 'Unsupported Auth0 operation.')
        method, path = routes[operation]
        if '{id}' in path:
            if not isinstance(identifier, str) or not 1 <= len(identifier) <= 300 or identifier in ('.', '..'):
                raise Auth0Error('INVALID_INPUT', 'A valid identifier is required.')
            path = path.replace('{id}', quote(identifier, safe=''))
        kind = 'write' if method == 'DELETE' else 'read'
        if self._closed:
            raise Auth0Error('CLIENT_CLOSED', 'Auth0 client is closed.')
        if kind == 'write' and not self._config.get('allowWrite'):
            raise Auth0Error('WRITE_DISABLED', 'Auth0 writes are disabled.')
        auth_retry = False
        retries = 0
        waited = 0.0
        while True:
            token = self._token(kind)
            try:
                response = requests.request(
                    method,
                    self._base + '/api/v2' + path,
                    headers={'Authorization': 'Bearer ' + token},
                    params=params,
                    timeout=(5, 15),
                    allow_redirects=False,
                )
            except requests.exceptions.RequestException:
                raise Auth0Error('AUTH0_UNAVAILABLE', 'Auth0 could not be reached.', retryable=kind == 'read') from None
            status = response.status_code
            if status == 401:
                self._invalidate(kind, token)
                if kind == 'read' and not auth_retry:
                    auth_retry = True
                    continue
                raise Auth0Error('AUTHENTICATION_FAILED', 'Auth0 authentication failed.')
            if 200 <= status < 300:
                if status == 204 or not response.content:
                    return {}
                try:
                    return response.json()
                except ValueError:
                    raise Auth0Error('API_ERROR', 'Auth0 returned an invalid response.') from None
            if status == 429 or 500 <= status < 600:
                delay = max(2**retries, _retry_after(response.headers))
                if kind == 'read' and retries < 2 and 0 <= delay <= 10 - waited:
                    time.sleep(delay)
                    waited += delay
                    retries += 1
                    continue
                raise Auth0Error(
                    'RATE_LIMITED' if status == 429 else 'AUTH0_UNAVAILABLE',
                    'Auth0 rate limit reached.' if status == 429 else 'Auth0 is unavailable.',
                    retryable=kind == 'read',
                    retry_after_seconds=_retry_after(response.headers) or None if status == 429 else None,
                )
            if status == 404:
                raise Auth0Error(
                    'USER_NOT_FOUND'
                    if operation
                    in (
                        'get_user',
                        'get_user_logs',
                        'get_user_blocks',
                        'get_user_roles',
                        'get_user_permissions',
                        'unblock_user',
                    )
                    else 'RESOURCE_NOT_FOUND',
                    'The requested Auth0 resource was not found.',
                )
            if status == 403:
                try:
                    body = response.json()
                    codes = {body.get('error'), body.get('errorCode')} if isinstance(body, dict) else set()
                except ValueError:
                    codes = set()
                if 'insufficient_scope' in codes:
                    raise Auth0Error('MISSING_SCOPE', 'The Auth0 application lacks a required permission.')
                # Tenants without the plan entitlement (for example, Organizations) are rejected with 403.
                if codes & {'operation_not_supported', 'feature_not_enabled'}:
                    raise Auth0Error('FEATURE_UNAVAILABLE', 'The Auth0 tenant is not entitled to this feature.')
            raise Auth0Error('API_ERROR', 'Auth0 rejected the request.')
