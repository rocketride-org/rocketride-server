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
Shared Google Workspace credential and request machinery — the ONE copy.

Every Google Workspace tool service (gmail, sheets, docs, calendar, drive)
declares a :class:`GoogleService` profile and calls through these functions.
This file owns everything that guards credentials and requests:

- credential construction (service-account and user OAuth) with a validated
  ``token_uri`` (Google hosts only) and a validated broker refresh URL
  (https + trusted broker hosts, ``RR_OAUTH_BROKER_URL`` for self-hosted);
- the broker-backed ``refresh()`` that fails loud on HTTP rejection,
  connection errors, malformed bodies, and 200s without an access token,
  and clears a stale expiry so a fresh token is never re-refreshed per call;
- scope diagnostics (:func:`token_scope_report`) shared by ``validateConfig``,
  ``check_connection``, and ``build_service`` so the three checks cannot drift;
- request execution with exponential backoff on 429/5xx and on rate-limit
  403s (parsed from the structured error body), while permission 403s and
  other errors fail fast with an agent-readable message.

Per-service subpackages keep only their tool functions and response cleaners,
and bind these functions via ``functools.partial`` (see e.g. ``sheets/client.py``).
"""

from __future__ import annotations

import base64
import binascii
import json
import os
import time as _time
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlparse

_G = 'https://www.googleapis.com/auth'


@dataclass(frozen=True)
class GoogleService:
    """Profile of one Google Workspace service consuming the shared machinery.

    ``superset_scopes``: granted scopes that implicitly satisfy any request for
    this service (e.g. a Sheets write grant covers a readonly node); a literal
    membership check would otherwise false-error when a broader grant exists.
    """

    product: str  # human label used in error messages, e.g. 'Google Sheets'
    api: str  # discovery service name, e.g. 'sheets'
    version: str  # discovery service version, e.g. 'v4'
    superset_scopes: frozenset[str] = field(default_factory=frozenset)


# Hosts the token-refresh POST may target. The token payload is untrusted (it
# rides in saved pipes and broker responses); a token-supplied refresh URL is
# honored only if it is https and its host is one of these, so a tampered token
# can never redirect the refresh_token to an attacker host. RR_OAUTH_BROKER_URL
# lets self-hosted deployments add their own broker host.
_BROKER_HOSTS = frozenset({'oauth2.rocketride.ai', 'oauth.rocketride.ai'})

# Google's OAuth2 token endpoints. token_uri rides in the saved token (untrusted);
# the standard-credentials refresh POSTs the refresh_token there, so only Google's
# own hosts are accepted — a tampered token can't redirect credentials elsewhere.
_GOOGLE_TOKEN_HOSTS = frozenset({'oauth2.googleapis.com', 'accounts.google.com'})

# HTTP status codes worth retrying (rate-limit + transient server errors).
_RETRY_STATUSES = {429, 500, 502, 503, 504}


def resolve_refresh_url(svc: GoogleService, token_url: object) -> str | None:
    """Validate a token-supplied refresh URL against the trusted broker hosts.

    Returns the URL when it is https and its host is a known broker host
    (built-in or the RR_OAUTH_BROKER_URL host). Returns None when the token
    carries no URL. Raises ValueError for any other value so a tampered token
    fails loud instead of silently posting credentials elsewhere.
    """
    if not token_url:
        return None
    if not isinstance(token_url, str):
        raise ValueError(f'{svc.product} token oauth_server_url must be a string')

    allowed = set(_BROKER_HOSTS)
    env_broker = os.environ.get('RR_OAUTH_BROKER_URL', '')
    if env_broker:
        env_host = urlparse(env_broker).hostname
        if not env_host:
            # A schemeless value ("broker.example.com") parses with no hostname;
            # treat it as a bare host instead of silently dropping the allowlist entry.
            env_host = urlparse('//' + env_broker).hostname
        if env_host:
            allowed.add(env_host.lower())

    parsed = urlparse(token_url)
    if parsed.scheme != 'https' or not parsed.hostname or parsed.hostname.lower() not in allowed:
        raise ValueError(
            f'{svc.product} token refresh URL {token_url!r} is not a trusted OAuth broker '
            '(expected https and one of: ' + ', '.join(sorted(allowed)) + '). '
            'Reconnect your Google account, or set RR_OAUTH_BROKER_URL for a self-hosted broker.'
        )
    return token_url


def resolve_token_uri(svc: GoogleService, token_uri: object) -> str:
    """Return a trusted Google token endpoint, or raise for a tampered value.

    Defaults to Google's standard endpoint when absent. Any present value must be
    https with a Google token host, else ValueError (fail loud, never silently POST
    the refresh_token to an attacker host).
    """
    default = 'https://oauth2.googleapis.com/token'
    if not token_uri:
        return default
    if not isinstance(token_uri, str):
        raise ValueError(f'{svc.product} token_uri must be a string')
    parsed = urlparse(token_uri)
    if parsed.scheme != 'https' or not parsed.hostname or parsed.hostname.lower() not in _GOOGLE_TOKEN_HOSTS:
        raise ValueError(
            f'{svc.product} token_uri {token_uri!r} is not a trusted Google OAuth endpoint '
            '(expected https and one of: ' + ', '.join(sorted(_GOOGLE_TOKEN_HOSTS)) + '). '
            'Reconnect your Google account.'
        )
    return token_uri


def _parsed_error_body(exc: Exception) -> dict:
    """Return the JSON error body's ``error`` object, or ``{}`` if absent/malformed."""
    content = getattr(exc, 'content', b'') or b''
    if isinstance(content, bytes):
        content = content.decode('utf-8', 'replace')
    try:
        error = json.loads(content).get('error')
        return error if isinstance(error, dict) else {}
    except (ValueError, AttributeError, TypeError):
        return {}


def _structured_errors(exc: Exception) -> list[dict]:
    """Parse the JSON error body's reason-carrying entries, in either Google error shape.

    Legacy Discovery-style APIs (Gmail, Drive) carry ``error.errors[]``, each item
    already holding a ``reason`` (e.g. ``accessNotConfigured``). One Platform APIs
    (Sheets, Docs) carry no ``errors[]`` at all — the reason instead lives in a
    ``google.rpc.ErrorInfo`` entry inside ``error.details[]`` (e.g. ``reason:
    'SERVICE_DISABLED'``). Returns whichever shape is present, or ``[]`` if the
    body has neither (or is absent/malformed).
    """
    error = _parsed_error_body(exc)
    legacy = [e for e in (error.get('errors') or []) if isinstance(e, dict)]
    if legacy:
        return legacy
    return [
        d
        for d in (error.get('details') or [])
        if isinstance(d, dict) and d.get('@type') == 'type.googleapis.com/google.rpc.ErrorInfo'
    ]


def _error_reason_code(exc: Exception) -> str | None:
    """The first structured reason code verbatim (e.g. 'accessNotConfigured'), if present.

    Google distinguishes ``accessNotConfigured`` (API disabled on the project),
    ``forbidden`` (permission), and ``rateLimitExceeded``/``quotaExceeded`` under the
    same HTTP 403 — the reason code is what actually names the fix. Legacy APIs
    carry it in ``error.errors[].reason``; One Platform APIs carry it in an
    ``error.details[]`` ErrorInfo's ``reason`` (SCREAMING_SNAKE_CASE, e.g.
    ``SERVICE_DISABLED``), and when even that detail is absent this falls back to
    the coarser gRPC ``error.status`` (e.g. ``PERMISSION_DENIED``).
    """
    for e in _structured_errors(exc):
        if e.get('reason'):
            return str(e['reason'])
    status = _parsed_error_body(exc).get('status')
    return str(status) if status else None


def _is_rate_limit_403(exc: Exception) -> bool:
    """True when a 403 is a transient rate/quota limit (safe to retry) vs a permission error."""
    status = getattr(getattr(exc, 'resp', None), 'status', None)
    if not status or int(status) != 403:
        return False
    rate_reasons = {'ratelimitexceeded', 'userratelimitexceeded', 'quotaexceeded'}
    structured = _structured_errors(exc)
    # Prefer the structured error body over substring matching. Normalize away
    # underscores so One Platform's SCREAMING_SNAKE_CASE ErrorInfo reasons (e.g.
    # 'RATE_LIMIT_EXCEEDED') match the legacy camelCase set above.
    if structured:
        reasons = {str(e.get('reason', '')).lower().replace('_', '') for e in structured}
        return bool(reasons & rate_reasons)
    # Fallback for non-JSON bodies, transport-level wrappers, and any reason
    # taxonomy _structured_errors doesn't recognize (e.g. a details[] entry
    # whose @type isn't ErrorInfo) — keep this even as the parser above grows,
    # since it is the only path a shape neither branch above covers still hits.
    content = getattr(exc, 'content', b'') or b''
    if isinstance(content, bytes):
        content = content.decode('utf-8', 'replace')
    blob = (str(getattr(exc, 'reason', '') or '') + ' ' + content).lower()
    return any(reason in blob for reason in rate_reasons)


def _decode_blob(value: str) -> str:
    """Return text from a raw string or a base64 ``data:`` URL (serviceKey/userToken fields)."""
    if not value:
        raise ValueError('missing credential value')
    if value.startswith('data:'):
        _, _, payload = value.partition(',')
        try:
            return base64.b64decode(payload).decode('utf-8')
        except (binascii.Error, ValueError) as exc:
            raise ValueError(f'could not decode data-url credential: {exc}') from exc
    return value


def _missing_scopes(svc: GoogleService, granted: set[str], required: list[str]) -> list[str]:
    """Required scopes not covered by the granted set (superset-aware).

    Two layers of implication: the service's own superset scopes (e.g. the
    full-mailbox or full-drive scope covers every tier), then the shared
    ``google_access.missing_scopes`` rules (gmail.modify covers
    gmail.readonly, a writable scope covers its ``.readonly`` counterpart —
    the #1548 upgrade, applied here so all five services get it).
    """
    if granted & svc.superset_scopes:
        return []
    from nodes.core.google_access import missing_scopes

    return missing_scopes(granted, required)


def token_scope_report(svc: GoogleService, cfg: dict, required: list[str]) -> tuple[set[str], bool, list[str]]:
    """Decode the config's userToken and report (granted, covered, missing) for ``required``.

    The single source of truth for scope diagnostics: ``IGlobal.validateConfig``,
    ``IInstance.check_connection``, and ``build_service`` all judge scopes through
    this function so the three checks cannot drift. An absent token or a token
    without a scope field yields (granted, True, []) — nothing to judge. Raises
    ValueError when the token payload is malformed.
    """
    token_str = str(cfg.get('userToken') or '').strip()
    if not token_str:
        return set(), True, []
    info = json.loads(_decode_blob(token_str))
    granted = {s for s in (info.get('scope') or '').split() if s}
    if not granted:
        return granted, True, []
    missing = _missing_scopes(svc, granted, required)
    return granted, not missing, missing


class _BrokerCredentials:  # real base class is google.oauth2.credentials.Credentials
    """User credentials whose refresh goes through the RocketRide OAuth broker.

    Broker-issued tokens carry no client_id/client_secret (those belong to the
    broker's Google app), so google-auth's own refresh cannot work; refresh()
    POSTs the refresh_token to the validated broker URL instead. Defined at
    module scope (mixed into the real Credentials class in build_service) so
    the refresh logic is unit-testable independently of credential building.
    """

    _broker_url: 'str | None' = None
    _product: str = ''

    def refresh(self, request: object) -> None:  # type: ignore[override]
        import datetime as _dt
        import urllib.error as _uerr
        import urllib.request as _req

        import google.auth.exceptions as _gae

        if not self._broker_url or not self.refresh_token:
            raise _gae.RefreshError(
                f'{self._product} access token has expired. Please reconnect your Google account in the node settings.'
            )
        body = json.dumps({'refresh_token': self.refresh_token}).encode()
        req = _req.Request(
            self._broker_url,
            data=body,
            headers={'Content-Type': 'application/json'},
            method='POST',
        )
        try:
            with _req.urlopen(req, timeout=10) as resp:
                raw = resp.read().decode()
            data = json.loads(raw)
        except _uerr.HTTPError as exc:
            # HTTPError subclasses URLError: catch it first so a broker
            # rejection (401/500/...) is not misreported as unreachable.
            raise _gae.RefreshError(
                f'{self._product} token refresh was rejected by the broker (HTTP {exc.code}). '
                'Please reconnect your Google account.'
            ) from exc
        except _uerr.URLError as exc:
            raise _gae.RefreshError(
                f'{self._product} token refresh failed (broker unreachable: {exc}). '
                'Please reconnect your Google account.'
            ) from exc
        except OSError as exc:
            # e.g. a socket timeout raised from resp.read(); URLError is
            # a subclass of OSError so this branch must follow it.
            raise _gae.RefreshError(
                f'{self._product} token refresh failed (connection error during broker request: {exc}). '
                'Please reconnect your Google account.'
            ) from exc
        except (ValueError, json.JSONDecodeError) as exc:
            raise _gae.RefreshError(
                f'{self._product} token refresh returned a malformed response. Please reconnect your Google account.'
            ) from exc
        token = data.get('access_token') if isinstance(data, dict) else None
        if not token:
            # A 200 without an access token is a broker contract violation;
            # keeping the stale token would just fail again downstream.
            raise _gae.RefreshError(
                f'{self._product} token refresh returned no access token. Please reconnect your Google account.'
            )
        # Validate the expiry BEFORE committing the token: a garbage
        # expiry_date must surface as RefreshError, not leave the credentials
        # half-updated (new token, stale expiry) via TypeError/OverflowError.
        ms = data.get('expiry_date')
        expiry = None
        if ms:
            try:
                expiry = _dt.datetime.fromtimestamp(ms / 1000, tz=_dt.timezone.utc).replace(tzinfo=None)
            except (TypeError, ValueError, OverflowError, OSError) as exc:
                raise _gae.RefreshError(
                    f'{self._product} token refresh returned an invalid expiry_date ({ms!r}). '
                    'Please reconnect your Google account.'
                ) from exc
        self.token = token
        # A missing expiry must clear the old (past) value, or the fresh token
        # would look expired and re-POST to the broker on every call; None
        # means "not expiring" to google-auth.
        self.expiry = expiry


def _make_broker_credentials(svc: GoogleService, broker_url: 'str | None', **kwargs: Any):
    """Build a Credentials subclass instance whose refresh() uses the broker."""
    from google.oauth2.credentials import Credentials

    cls = type('BrokerCredentials', (_BrokerCredentials, Credentials), {})
    creds = cls(**kwargs)
    creds._broker_url = broker_url
    creds._product = svc.product
    return creds


def build_service(svc: GoogleService, auth_type: str, cfg: dict, scopes: list[str]) -> Any:
    """Build a discovery service for ``svc`` from node config, scoped to ``scopes``.

    ``auth_type`` selects service-account (serviceKey + optional adminEmail for
    domain-wide delegation) or user OAuth (userToken JSON).
    """
    from googleapiclient.discovery import build

    if auth_type == 'user':
        import datetime as _dt

        from google.oauth2.credentials import Credentials

        info = json.loads(_decode_blob(cfg.get('userToken') or ''))
        access_token = info.get('access_token') or info.get('token') or ''
        refresh_token = info.get('refresh_token')
        client_id = info.get('client_id')
        client_secret = info.get('client_secret')
        token_uri = resolve_token_uri(svc, info.get('token_uri'))
        # Untrusted input: reject any refresh URL not pointing at a known broker.
        oauth_server_url = resolve_refresh_url(svc, info.get('oauth_server_url'))
        expiry_date_ms = info.get('expiry_date')

        expiry: '_dt.datetime | None' = None
        if expiry_date_ms:
            expiry = _dt.datetime.fromtimestamp(expiry_date_ms / 1000, tz=_dt.timezone.utc).replace(tzinfo=None)

        _granted, scopes_covered, missing = token_scope_report(svc, cfg, scopes)
        if not scopes_covered:
            raise ValueError(
                f'{svc.product}: your Google account authorization is missing required scopes '
                'for the selected access tier. Please disconnect and reconnect your '
                f'Google account. Missing: {", ".join(missing)}'
            )

        if client_id and client_secret:
            # Standard Google OAuth2 credentials: the library handles refresh automatically.
            creds = Credentials(
                token=access_token,
                refresh_token=refresh_token,
                token_uri=token_uri,
                client_id=client_id,
                client_secret=client_secret,
                scopes=scopes,
            )
            if expiry is not None:
                creds.expiry = expiry
        else:
            # Fail fast: if the token is already expired and there is no refresh path
            # (no broker URL and no client credentials), the first API call would fail
            # with a cryptic RefreshError. Surface a clear message now.
            now = _dt.datetime.now(_dt.timezone.utc).replace(tzinfo=None)
            if expiry is not None and expiry < now and not oauth_server_url:
                raise ValueError(
                    f'{svc.product} access token has expired. '
                    'Please reconnect your Google account in the node settings.'
                )
            # Broker-issued token: client_id/client_secret belong to the broker's Google app
            # and are never embedded in the token. refresh() goes to the broker instead
            # of Google directly (see _BrokerCredentials at module scope).
            creds = _make_broker_credentials(
                svc,
                oauth_server_url,
                token=access_token,
                refresh_token=refresh_token,
                token_uri=token_uri,
                client_id=None,
                client_secret=None,
                scopes=scopes,
            )
            if expiry is not None:
                creds.expiry = expiry
    else:
        from google.oauth2 import service_account

        info = json.loads(_decode_blob(cfg.get('serviceKey') or ''))
        creds = service_account.Credentials.from_service_account_info(info, scopes=scopes)
        admin_email = (cfg.get('adminEmail') or '').strip()
        if admin_email:
            # Domain-wide delegation: act as the named user.
            creds = creds.with_subject(admin_email)

    return build(svc.api, svc.version, credentials=creds, cache_discovery=False)


def execute(svc: GoogleService, request: Any, *, binary: bool = False) -> Any:
    """Run an API request with exponential backoff on 429/5xx and rate-limit 403s.

    ``binary=True`` returns the raw response (bytes from get_media/export_media);
    otherwise the JSON dict (or {} when the API returns no body). With 4 attempts
    the sleeps are 1s, 2s, 4s — worst case ~7s before the final raise.
    """
    base_delay = 1.0
    for attempt in range(4):
        try:
            result = request.execute()
            return result if binary else (result or {})
        except Exception as exc:  # googleapiclient.errors.HttpError and transport errors
            status = getattr(getattr(exc, 'resp', None), 'status', None)
            if status and (int(status) in _RETRY_STATUSES or _is_rate_limit_403(exc)) and attempt < 3:
                _time.sleep(base_delay * (2**attempt))
                continue
            detail = getattr(exc, 'reason', None) or str(exc)
            reason_code = _error_reason_code(exc)
            status_int = int(status) if status else None
            if status_int == 403:
                err = ValueError(
                    f'{svc.product} API 403 ({reason_code or "forbidden"}): {detail}. If this is a scope '
                    'error, disconnect and reconnect your Google account with the required access tier. '
                    'If it is a sharing/ownership error, the account may lack permission on that resource. '
                    'If it is accessNotConfigured or SERVICE_DISABLED, the Google Cloud project behind '
                    'this credential has not enabled this API.'
                )
            else:
                prefix = f'{svc.product} API {status}: ' if status else f'{svc.product} request failed: '
                err = ValueError(f'{prefix}{detail}')
            err.status = status_int
            err.reason_code = reason_code
            raise err from exc
    raise RuntimeError('execute: retry loop exhausted unexpectedly')  # unreachable
