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
HTTP Request tool node - global (shared) state.

Reads config and stores security guardrails (allowed methods + URL whitelist),
the configured credential and default headers, and the rate limiter for
IInstance tool methods.
"""

from __future__ import annotations

import re
from ai.common.config import Config
from rocketlib import IGlobalBase, OPEN_MODE, warning

from ai.common.utils import config_int

from .rate_limiter import DEFAULT_MAX_CONCURRENT, DEFAULT_MAX_PER_MINUTE, DEFAULT_MAX_PER_SECOND, RateLimiter


_METHOD_FLAGS = {
    'GET': 'allowGET',
    'POST': 'allowPOST',
    'PUT': 'allowPUT',
    'PATCH': 'allowPATCH',
    'DELETE': 'allowDELETE',
    'HEAD': 'allowHEAD',
    'OPTIONS': 'allowOPTIONS',
}

# Config fields that belong to each authType; the rest are reported as unused.
_AUTH_FIELDS = {
    'none': frozenset(),
    'bearer': frozenset({'authToken'}),
    'basic': frozenset({'authUsername', 'authPassword'}),
    'api_key': frozenset({'authHeaderName', 'authHeaderValue'}),
}
_ALL_AUTH_FIELDS = frozenset().union(*_AUTH_FIELDS.values())

# A ${...} left in a config value means the engine found no variable for it.
_UNRESOLVED_PLACEHOLDER = re.compile(r'\$\{[^}]*\}')
# RFC 9110 field-name token.
_HEADER_NAME = re.compile(r"^[!#$%&'*+.^_`|~0-9A-Za-z-]+$")
# Credential-bearing headers the agent must not set per call while config auth
# is on, and must not place in defaultHeaders.
_CREDENTIAL_HEADERS = frozenset({'authorization', 'proxy-authorization', 'cookie', 'host'})
# Body-derived headers: a default would win over multipart/json boundaries.
_BODY_HEADERS = frozenset({'content-type', 'content-length', 'transfer-encoding'})
_RESERVED_DEFAULT_HEADERS = _CREDENTIAL_HEADERS | _BODY_HEADERS


def _config_text(cfg: dict, key: str) -> str:
    value = cfg.get(key)
    return value.strip() if isinstance(value, str) else ''


def _check_wire_value(label: str, value: str) -> None:
    """Reject config values that must never be sent as-is."""
    unresolved = _UNRESOLVED_PLACEHOLDER.search(value)
    if unresolved:
        raise ValueError(
            f'{label} still contains the unresolved placeholder {unresolved.group(0)}; '
            'set that variable in the org, team, or user environment'
        )
    if '<REDACTED>' in value:
        raise ValueError(
            f'{label} references a variable outside the ROCKETRIDE_* namespace; only ${{ROCKETRIDE_*}} resolves'
        )
    if '\r' in value or '\n' in value:
        raise ValueError(f'{label} must not contain line breaks')


def _pattern_pins_https_host(source: str) -> bool:
    """Whether a whitelist pattern starts with a literal https scheme and one exact host.

    Mirrors the head of the request-time authority grammar in IInstance: an
    optional anchor, ``https://``, then a literal (escaped) DNS or IPv4 host or
    a bracketed IPv6 literal, followed by a port, path, query, group, or end.
    Anything that can widen the host (an unescaped dot, class, group,
    alternation, or quantifier) does not pin it.
    """
    position = 2 if source.startswith(r'\A') else 1 if source.startswith('^') else 0
    if not source.startswith('https://', position):
        return False
    position += len('https://')
    if source.startswith(r'\[', position):
        return source.find(r'\]', position + 2) > position + 2
    start = position
    while position < len(source):
        if source[position].isascii() and (source[position].isalnum() or source[position] in '-_%'):
            position += 1
        elif source[position] == '\\' and position + 1 < len(source) and source[position + 1] in '.-_':
            position += 2
        else:
            break
    return position > start and (position == len(source) or source[position] in ':/($\\')


class IGlobal(IGlobalBase):
    """Global state for http_request."""

    enabled_methods: set[str] | None = None
    url_patterns: list[re.Pattern] | None = None
    config_auth: dict | None = None
    default_headers: dict[str, str] | None = None
    rate_limiter: RateLimiter | None = None

    def beginGlobal(self) -> None:
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return

        cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
        self.enabled_methods, self.url_patterns = self._build_guardrails(cfg)
        if self.url_patterns:
            warning(
                'URL whitelist patterns now require a supported, explicit authority boundary; '
                'review existing patterns before making requests'
            )
        self.config_auth = self._build_config_auth(cfg)
        self.default_headers = self._build_default_headers(cfg)
        self._require_pinned_whitelist(
            self.url_patterns, self._whitelist_reason(self.config_auth, self.default_headers)
        )
        unused = self._unused_auth_fields(cfg)
        if unused:
            warning(f'authType is {_config_text(cfg, "authType") or "none"!r}; {", ".join(unused)} will not be sent')
        self.rate_limiter = self._build_rate_limiter(cfg)

    @staticmethod
    def _build_config_auth(cfg: dict) -> dict | None:
        """Read the configured credential into the same shape as a per-call ``auth`` object.

        Returns ``None`` when ``authType`` is ``none``. Every other type must be
        complete and must not carry an unresolved ``${...}`` placeholder: a
        credential that is configured but silently dropped is the failure this
        node exists to avoid.
        """
        raw_type = cfg.get('authType')
        if raw_type is not None and not isinstance(raw_type, str):
            raise ValueError(f'authType must be a string; got {type(raw_type).__name__}')
        auth_type = _config_text(cfg, 'authType').lower() or 'none'
        if auth_type not in _AUTH_FIELDS:
            raise ValueError(f'authType must be one of {sorted(_AUTH_FIELDS)}; got {auth_type!r}')
        if auth_type == 'none':
            return None

        if auth_type == 'bearer':
            token = _config_text(cfg, 'authToken')
            if not token:
                raise ValueError('authType is "bearer" but authToken is empty')
            _check_wire_value('authToken', token)
            return {'type': 'bearer', 'bearer': {'token': token}}

        if auth_type == 'basic':
            username = _config_text(cfg, 'authUsername')
            password = _config_text(cfg, 'authPassword')
            if not username:
                raise ValueError('authType is "basic" but authUsername is empty')
            _check_wire_value('authUsername', username)
            _check_wire_value('authPassword', password)
            return {'type': 'basic', 'basic': {'username': username, 'password': password}}

        name = _config_text(cfg, 'authHeaderName')
        value = _config_text(cfg, 'authHeaderValue')
        if not name:
            raise ValueError('authType is "api_key" but authHeaderName is empty')
        if not _HEADER_NAME.match(name):
            raise ValueError(f'authHeaderName {name!r} is not a valid HTTP header name')
        if name.lower() == 'host':
            raise ValueError('authHeaderName cannot be Host; it is derived from the validated URL')
        if not value:
            raise ValueError('authType is "api_key" but authHeaderValue is empty')
        _check_wire_value('authHeaderValue', value)
        return {'type': 'api_key', 'api_key': {'key': name, 'value': value, 'add_to': 'header'}}

    @staticmethod
    def _build_default_headers(cfg: dict) -> dict[str, str]:
        """Read the default-header rows; blank rows are ignored, malformed ones fail closed."""
        raw_rows = cfg.get('defaultHeaders')
        if raw_rows is None or raw_rows == '':
            raw_rows = []
        if not isinstance(raw_rows, list):
            import json

            try:
                raw_rows = json.loads(str(raw_rows))
                if not isinstance(raw_rows, list):
                    raise ValueError(f'defaultHeaders must be a JSON array, got {type(raw_rows).__name__}')
            except (json.JSONDecodeError, TypeError, ValueError) as e:
                raise ValueError(f'defaultHeaders is malformed and cannot be parsed: {e}') from e

        headers: dict[str, str] = {}
        seen: set[str] = set()
        for index, row in enumerate(raw_rows):
            if not hasattr(row, 'get'):
                raise ValueError(f'defaultHeaders entry {index + 1} must be an object')
            raw_name = row.get('headerName')
            raw_value = row.get('headerValue')
            if raw_name is not None and not isinstance(raw_name, str):
                raise ValueError(f'defaultHeaders entry {index + 1} headerName must be a string')
            if raw_value is not None and not isinstance(raw_value, str):
                raise ValueError(f'defaultHeaders entry {index + 1} headerValue must be a string')
            name = (raw_name or '').strip()
            value = (raw_value or '').strip()
            if not name and not value:
                continue
            if not name:
                raise ValueError(f'defaultHeaders entry {index + 1} has a value but no header name')
            if not _HEADER_NAME.match(name):
                raise ValueError(f'defaultHeaders entry {index + 1}: {name!r} is not a valid HTTP header name')
            if name.lower() in _RESERVED_DEFAULT_HEADERS:
                raise ValueError(
                    f'defaultHeaders entry {index + 1}: {name} cannot be a default header; '
                    'use the Authentication fields for credentials'
                )
            if name.lower() in seen:
                raise ValueError(f'defaultHeaders entry {index + 1}: {name} is listed more than once')
            _check_wire_value(f'defaultHeaders entry {index + 1} ({name})', value)
            seen.add(name.lower())
            headers[name] = value
        return headers

    @staticmethod
    def _whitelist_reason(config_auth: dict | None, default_headers: dict[str, str] | None) -> str | None:
        """Why a pinned https whitelist is mandatory, or None when it is optional."""
        if config_auth is not None:
            return 'authType is set'
        if default_headers:
            return 'defaultHeaders is set'
        return None

    @staticmethod
    def _require_pinned_whitelist(patterns: list[re.Pattern], reason: str | None) -> None:
        """Configured credentials and default headers may only travel to exact https hosts."""
        if not reason:
            return
        if not patterns:
            raise ValueError(
                f'{reason} but the URL whitelist is empty; add at least one '
                '^https://<exact host> pattern so configured values only reach approved hosts'
            )
        for pattern in patterns:
            if not _pattern_pins_https_host(pattern.pattern):
                raise ValueError(
                    f'URL whitelist pattern {pattern.pattern!r} does not pin an exact https host; '
                    f'while {reason}, every pattern must start with https:// '
                    r'followed by a literal host with escaped dots, e.g. ^https://api\.github\.com/'
                )

    @staticmethod
    def _unused_auth_fields(cfg: dict) -> list[str]:
        """Names of filled-in credential fields that the selected authType never sends."""
        auth_type = _config_text(cfg, 'authType').lower() or 'none'
        active = _AUTH_FIELDS.get(auth_type, frozenset())
        return sorted(name for name in _ALL_AUTH_FIELDS - active if _config_text(cfg, name))

    @staticmethod
    def _build_guardrails(cfg: dict) -> tuple[set[str], list[re.Pattern]]:
        """Read allowed-methods checkboxes and URL whitelist from the config."""
        enabled: set[str] = set()
        for method, flag in _METHOD_FLAGS.items():
            if cfg.get(flag, method in ('GET', 'POST', 'PUT', 'PATCH', 'DELETE')):
                enabled.add(method)

        raw_whitelist = cfg.get('urlWhitelist')
        if raw_whitelist is None or raw_whitelist == '':
            raw_whitelist = []
        if not isinstance(raw_whitelist, list):
            import json

            try:
                raw_whitelist = json.loads(str(raw_whitelist))
                if not isinstance(raw_whitelist, list):
                    raise ValueError(f'urlWhitelist must be a JSON array, got {type(raw_whitelist).__name__}')
            except (json.JSONDecodeError, TypeError, ValueError) as e:
                raise ValueError(f'urlWhitelist is malformed and cannot be parsed: {e}') from e
        patterns: list[re.Pattern] = []
        for index, row in enumerate(raw_whitelist):
            if not hasattr(row, 'get'):
                raise ValueError(f'urlWhitelist entry {index + 1} must be an object')
            raw_pattern = row.get('whitelistPattern')
            if not isinstance(raw_pattern, str):
                raise ValueError(f'urlWhitelist entry {index + 1} whitelistPattern must be a string')
            pat_str = raw_pattern.strip()
            if not pat_str:
                continue
            try:
                patterns.append(re.compile(pat_str))
            except re.error as e:
                raise ValueError(f'Invalid URL whitelist regex {pat_str!r}: {e}') from e

        return enabled, patterns

    @staticmethod
    def _build_rate_limiter(cfg: dict) -> RateLimiter | None:
        """Create a ``RateLimiter`` from the node configuration.

        Returns ``None`` when all three rate-limit knobs are explicitly set to
        ``0`` (i.e. the user has opted out of rate limiting).
        """
        raw_ps = cfg.get('rateLimitPerSecond')
        raw_pm = cfg.get('rateLimitPerMinute')
        raw_mc = cfg.get('maxConcurrentRequests')

        # If all three are explicitly set to 0, disable rate limiting entirely.
        def _is_zero(raw: object) -> bool:
            if raw is None:
                return False
            try:
                return int(raw) == 0
            except (TypeError, ValueError):
                return False

        if _is_zero(raw_ps) and _is_zero(raw_pm) and _is_zero(raw_mc):
            return None

        return RateLimiter(
            max_per_second=config_int(cfg, 'rateLimitPerSecond', DEFAULT_MAX_PER_SECOND, min_value=1),
            max_per_minute=config_int(cfg, 'rateLimitPerMinute', DEFAULT_MAX_PER_MINUTE, min_value=1),
            max_concurrent=config_int(cfg, 'maxConcurrentRequests', DEFAULT_MAX_CONCURRENT, min_value=1),
        )

    def validateConfig(self) -> None:
        try:
            cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
            server_name = str((cfg.get('serverName') or '')).strip()
            if not server_name:
                warning('serverName is required')

            _, patterns = self._build_guardrails(cfg)
            config_auth = self._build_config_auth(cfg)
            default_headers = self._build_default_headers(cfg)
            reason = self._whitelist_reason(config_auth, default_headers)
            if not patterns and not reason:
                warning('URL whitelist is empty — all public URLs will be allowed')
            self._require_pinned_whitelist(patterns, reason)
            unused = self._unused_auth_fields(cfg)
            if unused:
                warning(
                    f'authType is {_config_text(cfg, "authType") or "none"!r}; {", ".join(unused)} will not be sent'
                )
        except Exception as e:
            warning(str(e))

    def endGlobal(self) -> None:
        self.enabled_methods = set()
        self.url_patterns = []
        self.config_auth = None
        self.default_headers = {}
        self.rate_limiter = None
