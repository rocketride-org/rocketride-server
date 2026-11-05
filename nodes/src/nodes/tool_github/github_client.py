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
GitHub REST API v3 and GraphQL client.

Thin wrapper around requests — handles auth, headers, error parsing,
and response normalisation. All tool methods in IInstance call through here.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Callable
from email.utils import parsedate_to_datetime
from urllib.parse import parse_qs, urlsplit
import datetime
import json
import math
import time

import jwt
import requests
from tenacity import RetryCallState, Retrying, retry_if_exception_type, stop_after_attempt, wait_exponential

from .graphql_guard import mutation_refusal


class GitHubAPIError(ValueError):
    """Raised when the GitHub API returns an error response.

    Carries the status, the response headers and the parsed JSON body (``None`` when
    the body is not JSON). It keeps no response or request object as an attribute;
    those carry the Authorization header that was sent.
    """

    def __init__(
        self,
        status_code: int,
        message: str,
        headers: Mapping[str, str] | None = None,
        body: Any = None,
    ):
        super().__init__(f'GitHub API {status_code}: {message}')
        self.status_code = status_code
        self.message = message
        self.headers = headers if headers is not None else {}
        self.body = body


class RateLimitError(Exception):
    """Raised when GitHub signals a rate limit (429 or 403 secondary limit)."""

    def __init__(self, response: requests.Response):
        self.response = response


def _rate_limit_hint(headers) -> str:
    """Human-readable retry hint from rate-limit headers, or '' if none present."""
    retry_after = headers.get('Retry-After')
    if retry_after:
        return f'retry after {retry_after}s'
    reset = headers.get('X-RateLimit-Reset')
    if reset:
        try:
            secs = max(0, int(float(reset) - time.time()))
            return f'rate limit resets in ~{secs}s'
        except ValueError:
            return f'rate limit resets at epoch {reset}'
    return ''


def is_too_large(exc: GitHubAPIError) -> bool:
    """Tell GitHub's refusal of a file over 100 MB (403 with error code ``too_large``) from other 403s."""
    if exc.status_code != 403 or not isinstance(exc.body, dict):
        return False
    errors = exc.body.get('errors')
    return isinstance(errors, list) and any(
        isinstance(error, dict) and error.get('code') == 'too_large' for error in errors
    )


def _raise_github_error(resp: requests.Response) -> None:
    """Parse GitHub error response and raise GitHubAPIError."""
    body = None
    try:
        err = resp.json()
        body = err
        msg = err.get('message', resp.text)
        if not isinstance(msg, str):
            msg = resp.text or resp.reason or 'unknown error'
        errors = err.get('errors')
        if errors:
            msg += ' — ' + '; '.join(e.get('message', str(e)) if isinstance(e, dict) else str(e) for e in errors)
    except Exception:
        msg = resp.text or resp.reason or 'unknown error'
    hint = _rate_limit_hint(resp.headers)
    if hint:
        msg += f' ({hint})'
    raise GitHubAPIError(resp.status_code, msg, headers=resp.headers, body=body)


BASE_URL = 'https://api.github.com'
DEFAULT_TIMEOUT = 30

# GitHub caps App JWT exp at 10 minutes; use 9m30s to leave clock-skew margin.
APP_JWT_TTL_SECONDS = 570


def _auth_headers(token: str) -> dict:
    """The headers every GitHub API request sends: bearer auth, media type, API version."""
    return {
        'Authorization': f'Bearer {token}',
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
    }


def load_app_private_key(pem_text: str):
    """Parse a PEM RSA private key for a GitHub App. Raises ValueError on malformed or non-RSA input."""
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric.rsa import RSAPrivateKey

    try:
        key = serialization.load_pem_private_key((pem_text or '').encode('utf-8'), password=None)
    except (ValueError, TypeError) as exc:
        raise ValueError(f'tool_github: invalid GitHub App private key: {exc}') from exc
    if not isinstance(key, RSAPrivateKey):
        raise ValueError('tool_github: GitHub App private key must be an RSA key (RS256 signing)')
    return key


def sign_app_jwt(app_id: str, private_key_pem: str) -> str:
    """Build and RS256-sign a short-lived JWT per GitHub App auth spec (iss=app_id)."""
    key = load_app_private_key(private_key_pem)
    now = int(time.time())
    # iat is backdated 60s so a client clock slightly ahead of GitHub's still passes.
    claims = {'iat': now - 60, 'exp': now + APP_JWT_TTL_SECONDS, 'iss': app_id}
    return jwt.encode(claims, key, algorithm='RS256')


def mint_installation_token(app_id: str, private_key_pem: str, installation_id: str) -> tuple[str, float]:
    """Mint a short-lived GitHub App installation token.

    POSTs to ``/app/installations/{installation_id}/access_tokens`` authenticated
    with a freshly-signed App JWT. Returns ``(token, expiry_epoch_seconds)``.
    """
    headers = _auth_headers(sign_app_jwt(app_id, private_key_pem))
    try:
        resp = requests.request(
            'POST',
            f'{BASE_URL}/app/installations/{installation_id}/access_tokens',
            headers=headers,
            timeout=DEFAULT_TIMEOUT,
        )
    except requests.RequestException as exc:
        raise ValueError(f'GitHub App token request failed: {exc}') from exc

    if not resp.ok:
        _raise_github_error(resp)

    try:
        data = resp.json()
    except ValueError as exc:
        raise GitHubAPIError(resp.status_code, f'installation token response is not JSON: {exc}') from exc
    token = data.get('token') if isinstance(data, dict) else None
    expires_at = data.get('expires_at') if isinstance(data, dict) else None
    if not token or not expires_at:
        raise GitHubAPIError(resp.status_code, 'installation token response missing token/expires_at')

    try:
        expiry = datetime.datetime.fromisoformat(str(expires_at).replace('Z', '+00:00')).timestamp()
    except ValueError as exc:
        raise GitHubAPIError(
            resp.status_code, f'installation token response has invalid expires_at: {expires_at}'
        ) from exc
    return token, expiry


def call(
    token: str,
    method: str,
    path: str,
    *,
    params: dict | None = None,
    body: dict | None = None,
) -> Any:
    """Make an authenticated GitHub API call and return the parsed JSON body.

    Raises ``ValueError`` with a human-readable message on HTTP errors.
    Returns an empty dict for 204 No Content responses.
    """
    resp = _exchange(token, method, path, params=params, body=body)
    return {} if resp.status_code == 204 else resp.json()


def _exchange(
    token: str,
    method: str,
    path: str,
    *,
    params: dict | None = None,
    body: dict | None = None,
) -> requests.Response:
    """Send one authenticated request with the node's retry policy and return a 2xx response.

    Used by ``call``, which returns the body; the envelope tools use ``request_with_backoff``.
    A rate limit is retried (at most three attempts with bounded waits); any other
    non-2xx answer raises ``GitHubAPIError``, and a transport failure ``ValueError``.
    """
    headers = _auth_headers(token)

    url = BASE_URL + path

    def _attempt() -> requests.Response:
        try:
            resp = requests.request(
                method.upper(),
                url,
                headers=headers,
                params={k: v for k, v in (params or {}).items() if v is not None},
                json=body,
                timeout=DEFAULT_TIMEOUT,
            )
        except requests.RequestException as exc:
            raise ValueError(f'GitHub request failed: {exc}') from exc

        if not resp.ok:
            is_rate_limit = resp.status_code == 429 or (
                resp.status_code == 403
                and (
                    'Retry-After' in resp.headers
                    or resp.headers.get('X-RateLimit-Remaining') == '0'
                    or 'rate limit' in resp.text.lower()
                )
            )
            if is_rate_limit:
                raise RateLimitError(resp)

            _raise_github_error(resp)

        return resp

    def github_rate_limit_wait(retry_state: RetryCallState) -> float:
        exc = retry_state.outcome.exception()
        if isinstance(exc, RateLimitError):
            hdrs = exc.response.headers

            def _check_and_cap(w: float) -> float:
                import math

                if not math.isfinite(w) or w < 0:
                    raise ValueError()
                if w > DEFAULT_TIMEOUT:
                    # Fail fast if server requires waiting longer than local cap
                    raise exc
                return w

            # 1. Retry-After provides exactly how many seconds to wait
            if 'Retry-After' in hdrs:
                try:
                    return _check_and_cap(float(hdrs['Retry-After']))
                except ValueError:
                    pass

            # 2. X-RateLimit-Reset provides epoch timestamp of reset
            if 'X-RateLimit-Reset' in hdrs:
                try:
                    reset_epoch = float(hdrs['X-RateLimit-Reset'])
                    sleep_time = reset_epoch - time.time()
                    return _check_and_cap(max(1.0, sleep_time))
                except ValueError:
                    pass
        return float(wait_exponential(multiplier=2, min=2, max=DEFAULT_TIMEOUT)(retry_state))

    try:
        return Retrying(
            stop=stop_after_attempt(3),
            wait=github_rate_limit_wait,
            retry=retry_if_exception_type(RateLimitError),
            reraise=True,
        )(_attempt)
    except RateLimitError as exc:
        exhausted = exc.response
    # Raised outside the handler, so the error has no __context__ that holds the response.
    _raise_github_error(exhausted)


# ---------------------------------------------------------------------------
# Result envelope for the repository-read tools: status, data, rate-limit
# counters and the next page, with HTTP errors returned as results and
# credentials redacted. The pre-existing tools keep returning bare bodies.
# ---------------------------------------------------------------------------

MAX_MESSAGE_LENGTH = 2000


def envelope(status: int | None, headers, data: Any) -> dict:
    """Build a result from public response facts: status, rate-limit counters, next page."""
    headers = headers if headers is not None else {}

    def counter(name):
        try:
            return int(headers[name])
        except (KeyError, TypeError, ValueError):
            return None

    next_page = None
    for link in requests.utils.parse_header_links(headers.get('Link') or ''):
        if link.get('rel') == 'next':
            try:
                page = int(parse_qs(urlsplit(link['url']).query)['page'][0])
                next_page = page if page > 0 else None
            except (KeyError, ValueError, IndexError):
                pass
    return {
        'status': status,
        'data': data,
        'rate_limit': {
            'remaining': counter('X-RateLimit-Remaining'),
            'limit': counter('X-RateLimit-Limit'),
            'reset': counter('X-RateLimit-Reset'),
            'resource': headers.get('X-RateLimit-Resource'),
        },
        'next_page': next_page,
    }


def failure_result(message: str, status: int | None = None, headers=None) -> dict:
    """Describe a failure as a result without data; counters are null when no response exists."""
    result = envelope(status, headers, None)
    del result['data']
    result['message'] = message
    result['documentation_url'] = None
    return result


def shape_failure(result: dict, expected: str) -> dict:
    """Turn a 2xx result whose body is not the expected shape into a failure result."""
    failure = {key: value for key, value in result.items() if key != 'data'}
    failure['message'] = f'GitHub returned an unexpected response body; expected {expected}.'
    failure['documentation_url'] = None
    return failure


def _error_message(status: int | None, body: Any, secrets: tuple[str, ...] = ()) -> str:
    """Compose a public message from the parsed error body, never from raw response text.

    The secrets are redacted before the cap, so a credential GitHub echoed across the
    cut cannot leave a prefix behind.
    """
    if not isinstance(body, dict) or not isinstance(body.get('message'), str):
        return f'GitHub returned HTTP {status} without a JSON error body.'
    message = body['message']
    errors = body.get('errors')
    if isinstance(errors, list) and errors:
        message = f'{message}: ' + '; '.join(_error_detail(error) for error in errors)
    return redact_result(message, secrets)[:MAX_MESSAGE_LENGTH]


def _error_detail(error) -> str:
    """One entry of GitHub's ``errors`` list as text: its ``message`` when it has one."""
    detail = error.get('message') if isinstance(error, dict) else None
    return detail if isinstance(detail, str) else str(error)


def redact_result(value: Any, secrets: tuple[str, ...]) -> Any:
    """Remove configured credentials from public read results, including errors."""
    # Longest first, so a secret that contains another is replaced whole. Sorted once: a
    # tree result can hold 100,000 entries with several strings each.
    ordered = tuple(sorted((s for s in secrets if s), key=len, reverse=True))
    if not ordered:
        return value

    def redact(item: Any) -> Any:
        if isinstance(item, str):
            for secret in ordered:
                item = item.replace(secret, '[REDACTED]')
            return item
        if isinstance(item, dict):
            return {redact(k): redact(v) for k, v in item.items()}
        if isinstance(item, list):
            return [redact(v) for v in item]
        return item

    return redact(value)


# ---------------------------------------------------------------------------
# Rate-limit backoff for the envelope tools (get_result and graphql_result).
# The legacy tools keep call()'s tenacity policy and its return shapes.
# ---------------------------------------------------------------------------

# 4 MiB: the issue's review query (40 pull requests with files, reviews, threads and checks)
# can pass 1 MiB.
DEFAULT_GRAPHQL_MAX_BYTES = 4 * 1024 * 1024
DEFAULT_RETRY_BUDGET_SECONDS = 60
DEFAULT_MAX_RETRIES = 3
# GitHub: with no retry-after and no exhausted x-ratelimit-remaining, "wait for at least
# one minute before retrying", then "an exponentially increasing amount of time".
UNNAMED_WAIT_SECONDS = 60.0
# The shortest wait between attempts, so Retry-After: 0 or a past reset cannot spin.
MIN_WAIT_SECONDS = 1.0
_READ_CHUNK_BYTES = 64 * 1024
_TRANSPORT_FAILURE = 'GitHub request failed or returned invalid JSON. Check connectivity and retry.'
_GRAPHQL_UNKNOWN_OUTCOME = (
    'GitHub did not return a usable response. The mutation may already have been applied. '
    'Check its current state before retrying to avoid duplicate changes.'
)
AUTH_FAILURE = 'GitHub authentication failed. Check the node credentials and installation access.'

# A token, or a function that returns the token to send; a function is called before
# every attempt, so a token refreshed (or a JWT signed again) during a wait is used.
Credential = str | Callable[[], str]


class AuthenticationFailed(Exception):
    """A credential could not be minted for a retry; the result is the fixed authentication failure."""


@dataclass(frozen=True)
class RetryPolicy:
    """How long, and how often, an envelope call waits out a GitHub rate limit.

    ``budget_seconds`` caps the total time one tool call spends waiting, across every
    request it makes (see ``CallBudget``), and ``max_retries`` the retries of each
    request after its first attempt, so 3 retries means up to 4 attempts. ``sleep`` and
    ``clock`` are injectable for tests; ``None`` means ``time.sleep`` and ``time.time``,
    looked up when the call runs.
    """

    budget_seconds: float = DEFAULT_RETRY_BUDGET_SECONDS
    max_retries: int = DEFAULT_MAX_RETRIES
    sleep: Callable[[float], None] | None = None
    clock: Callable[[], float] | None = None


class RateLimitExhausted(GitHubAPIError):
    """A rate limit outlasted the retry budget or count.

    Like ``GitHubAPIError`` it carries the status, headers and parsed body, never the
    response. ``retry_after`` is the wait the next attempt needs, rounded up to whole
    seconds: the one GitHub named, or at least a minute when it named none.
    """

    def __init__(self, status_code: int, headers, body, retry_after: int, reason: str):
        super().__init__(status_code, 'GitHub rate limit.', headers=headers, body=body)
        self.retry_after = retry_after
        self.reason = reason


class CallBudget:
    """The wait budget of one tool call, shared by every request the call makes.

    A ``repo_tree`` walk passes one to each of its subtree reads, so
    ``rateLimitBudgetSeconds`` bounds the waiting of the whole call, not of each read.
    """

    def __init__(self) -> None:
        self.waited = 0.0


class Handed:
    """A credential provider that remembers every token it returned, for redaction.

    ``get_result`` and ``graphql_result`` redact with ``tokens``. ``IInstance._with_credentials``
    passes one in, so the node and the client read the same list and nothing counts a
    handed-out token twice.
    """

    def __init__(self, credential: Credential) -> None:
        self._credential = credential
        self.tokens: list[str] = []

    @classmethod
    def of(cls, credential: Credential | Handed) -> Handed:
        """``credential`` itself when it is already one of these, else a new provider around it."""
        return credential if isinstance(credential, cls) else cls(credential)

    def __call__(self) -> str:
        token = self._credential() if callable(self._credential) else self._credential
        self.tokens.append(token)
        return token


def request_with_backoff(
    credential: Credential,
    method: str,
    path: str,
    *,
    params: dict | None = None,
    body: dict | None = None,
    retry: RetryPolicy | None = None,
    max_bytes: int | None = None,
    graphql: bool = False,
    budget: CallBudget | None = None,
) -> tuple[requests.Response, bytes | None]:
    """Send a request, waiting out rate limits within ``retry``, and return ``(response, body)``.

    See ``_rate_limit`` for what counts as a rate limit. A wait GitHub names
    (``Retry-After``, or ``X-RateLimit-Reset`` once ``X-RateLimit-Remaining`` is 0;
    the longer when both apply) is used as given, at least one second. With no named
    wait the first is a minute and each later one doubles. A wait that does not fit
    the budget left is never started, and neither is a retry past ``max_retries``:
    the call raises ``RateLimitExhausted`` with that wait as ``retry_after``. The budget
    is ``budget`` when given (one per tool call), else this request's own. A callable
    ``credential`` is called before every attempt, so a retry after a long wait sends
    a token minted for it. With
    ``max_bytes`` the body is streamed and the returned body is ``None`` once it
    exceeds the cap. Transport failures raise ``ValueError`` without the exception
    text, which may include the request URL, and are never retried.
    """
    policy = retry or RetryPolicy()
    sleep = policy.sleep or time.sleep
    clock = policy.clock or time.time
    budget = budget if budget is not None else CallBudget()
    kwargs: dict = {
        'params': {k: v for k, v in (params or {}).items() if v is not None},
        'json': body,
        'timeout': DEFAULT_TIMEOUT,
    }
    if max_bytes is not None:
        kwargs['stream'] = True
    retries = 0
    unnamed = 0
    while True:
        token = credential() if callable(credential) else credential
        try:
            resp = requests.request(method.upper(), BASE_URL + path, headers=_auth_headers(token), **kwargs)
            content = _read_body(resp, max_bytes)
        except requests.RequestException:
            raise ValueError('GitHub request failed') from None
        if content is None:
            return resp, None
        now = clock()
        limited, wait = _rate_limit(resp, content, now, graphql=graphql)
        if not limited:
            return resp, content
        named = wait is not None
        wait = max(MIN_WAIT_SECONDS, wait if named else UNNAMED_WAIT_SECONDS * 2**unnamed)
        left = policy.budget_seconds - budget.waited
        if retries >= policy.max_retries:
            reason = f'Gave up after rateLimitMaxRetries ({policy.max_retries}) retries.'
        elif wait > left:
            asks = 'GitHub asks to wait' if named else 'GitHub names no wait, so the next wait is'
            reason = (
                f'Not retried: {asks} {math.ceil(wait)} s, more than the '
                f'{max(0, math.floor(left))} s left of rateLimitBudgetSeconds.'
            )
        else:
            sleep(wait)
            budget.waited += wait
            retries += 1
            unnamed += 0 if named else 1
            continue
        raise RateLimitExhausted(resp.status_code, resp.headers, _parse_json(content), math.ceil(wait), reason)


def _read_body(resp: requests.Response, max_bytes: int | None) -> bytes | None:
    """Return the body, or ``None`` once it passes ``max_bytes``; the rest is never read."""
    if max_bytes is None:
        return resp.content
    # Content-Length counts encoded bytes; trust it only for an unencoded body.
    declared = resp.headers.get('Content-Length') or ''
    encoded = (resp.headers.get('Content-Encoding') or 'identity').strip().lower() != 'identity'
    if declared.isdecimal() and not encoded and int(declared) > max_bytes:
        resp.close()
        return None
    body = bytearray()
    for chunk in resp.iter_content(chunk_size=_READ_CHUNK_BYTES):
        body += chunk
        if len(body) > max_bytes:
            resp.close()
            return None
    return bytes(body)


def _seconds(value) -> float | None:
    """Parse a header as a finite, non-negative number of seconds."""
    try:
        seconds = float(value)
    except (TypeError, ValueError):
        return None
    return seconds if math.isfinite(seconds) and seconds >= 0 else None


def _retry_after(value, now: float) -> float | None:
    """Read Retry-After as delta-seconds or as an HTTP date; ``None`` when it is neither."""
    seconds = _seconds(value)
    if seconds is not None or not isinstance(value, str):
        return seconds
    try:
        when = parsedate_to_datetime(value)
    except (TypeError, ValueError, IndexError):
        return None
    if when.tzinfo is None:
        when = when.replace(tzinfo=datetime.timezone.utc)
    return max(0.0, when.timestamp() - now)


def _graphql_rate_limited(resp: requests.Response, content: bytes, exhausted: bool) -> bool:
    """Whether a GraphQL HTTP 200 is a rate limit GitHub answered without running anything.

    Only an answer without ``data`` counts: one with partial data ran part of the
    document, so it is returned, never retried. It counts when it carries
    ``Retry-After``, an error of type ``RATE_LIMITED``, a message of GitHub's own that
    names a rate limit (the top-level ``message`` of a secondary limit, or an error
    without ``locations``), or, while ``X-RateLimit-Remaining`` is 0, an error without
    ``locations``. Parse and validation errors carry ``locations`` and may quote the
    document or its variables, so their text is never read as a rate limit. An error
    with ``path`` came from field execution, so GitHub ran the document: it never counts,
    whatever its text, since retrying could run a mutation twice.
    """
    hinted = b'RATE_LIMITED' in content or b'rate limit' in content.lower()
    if not ('Retry-After' in resp.headers or exhausted or hinted):
        return False
    # Parsed only when a hint is present, so an ordinary answer is parsed once.
    body = _parse_json(content)
    if not isinstance(body, dict) or body.get('data') is not None:
        return False
    raw_errors = body.get('errors')
    errors = [error for error in raw_errors if isinstance(error, dict)] if isinstance(raw_errors, list) else []
    unlocated = [error for error in errors if not error.get('locations') and not error.get('path')]
    own_words = [body.get('message')] + [error.get('message') for error in unlocated]
    return (
        'Retry-After' in resp.headers
        or any(error.get('type') == 'RATE_LIMITED' for error in errors)
        or any(isinstance(text, str) and 'rate limit' in text.lower() for text in own_words)
        or (exhausted and bool(unlocated))
    )


def _rate_limit(resp: requests.Response, content: bytes, now: float, *, graphql: bool) -> tuple[bool, float | None]:
    """Return whether the answer is a rate limit and the seconds GitHub names (``None``: none).

    A 403 or 429 is one when GitHub marks it so (a 429, ``X-RateLimit-Remaining: 0``,
    ``Retry-After``, or a body naming a rate limit). With ``graphql``, so is an HTTP
    200 that ``_graphql_rate_limited`` accepts.
    """
    headers = resp.headers
    exhausted = headers.get('X-RateLimit-Remaining') == '0'
    if resp.status_code in (403, 429):
        limited = resp.status_code == 429 or exhausted or 'Retry-After' in headers or b'rate limit' in content.lower()
    else:
        limited = graphql and resp.status_code == 200 and _graphql_rate_limited(resp, content, exhausted)
    if not limited:
        return False, None
    waits = []
    retry_after = _retry_after(headers.get('Retry-After'), now)
    if retry_after is not None:
        waits.append(retry_after)
    reset = _seconds(headers.get('X-RateLimit-Reset')) if exhausted else None
    if reset is not None:
        waits.append(reset - now)
    return True, (max(waits) if waits else None)


def _parse_json(content: bytes) -> Any:
    return _decode_json(content)[0]


def _decode_json(content: bytes) -> tuple[Any, bool]:
    """``(value, True)`` for a JSON body, ``(None, False)`` for one that is not JSON."""
    try:
        return json.loads(content), True
    except ValueError:
        return None, False


def _with_retry_after(result: dict, exc: RateLimitExhausted) -> dict:
    """Add why the node stopped and when to retry to a rate-limit failure."""
    message = result['message'].rstrip()
    separator = ' ' if message.endswith(('.', ')', '!', '?')) else '. '
    result['message'] = f'{message}{separator}{exc.reason}'
    result['retry_after'] = exc.retry_after
    return result


def _graphql_error(status: int, headers, body: Any, secrets: tuple[str, ...] = ()) -> dict:
    """Shape a GraphQL failure from its parsed body, never from raw response text."""
    body = body if isinstance(body, dict) else {}
    errors = body.get('errors')
    if isinstance(body.get('message'), str):
        message = _error_message(status, body, secrets)
    else:
        details = '; '.join(_error_detail(error) for error in errors) if isinstance(errors, list) else ''
        message = redact_result(details, secrets)[:MAX_MESSAGE_LENGTH]
        message = message or f'GitHub returned HTTP {status} without a JSON error body.'
    result = failure_result(message, status, headers)
    result['next_page'] = None
    documentation_url = body.get('documentation_url')
    result['documentation_url'] = documentation_url if isinstance(documentation_url, str) else None
    if errors is not None:
        result['errors'] = errors
    return result


def get_result(
    credential: Credential,
    path: str,
    *,
    params: dict | None = None,
    retry: RetryPolicy | None = None,
    secrets: tuple[str, ...] = (),
    budget: CallBudget | None = None,
) -> dict:
    """GET with the result envelope: HTTP errors become results and credentials are redacted.

    Every token sent and ``secrets`` (the node's other credentials) are redacted from
    the whole result, and from an error message before it is capped. Transport and
    JSON failures have ``status: None`` and a fixed message, so exception text never
    reaches a client. Rate limits back off within ``retry`` and ``budget`` (see
    ``request_with_backoff``); an exhausted budget or retry count returns the
    rate-limit answer with ``retry_after``.
    """
    handed = Handed.of(credential)
    try:
        resp, _content = request_with_backoff(handed, 'GET', path, params=params, retry=retry, budget=budget)
        if resp.status_code == 204:
            result = envelope(resp.status_code, resp.headers, {})
        elif not resp.ok:
            _raise_github_error(resp)
        else:
            result = envelope(resp.status_code, resp.headers, resp.json())
    except GitHubAPIError as exc:
        message = _error_message(exc.status_code, exc.body, (*handed.tokens, *secrets))
        result = failure_result(message, exc.status_code, exc.headers)
        if isinstance(exc.body, dict) and isinstance(exc.body.get('documentation_url'), str):
            result['documentation_url'] = exc.body['documentation_url']
        if isinstance(exc, RateLimitExhausted):
            _with_retry_after(result, exc)
    except AuthenticationFailed:
        result = failure_result(AUTH_FAILURE)
    except (ValueError, requests.RequestException):
        result = failure_result(_TRANSPORT_FAILURE)
    return redact_result(result, (*handed.tokens, *secrets))


def graphql_result(
    credential: Credential,
    query: str,
    variables: dict | None = None,
    operation_name: str | None = None,
    *,
    retry: RetryPolicy | None = None,
    max_bytes: int = DEFAULT_GRAPHQL_MAX_BYTES,
    secrets: tuple[str, ...] = (),
) -> dict:
    """POST a GraphQL document and return GitHub's ``data`` and ``errors`` in the envelope.

    GraphQL errors arrive with HTTP 200 and are returned in ``data.errors``, never
    raised. A non-2xx answer, or a rate limit that outlasts the retry policy, is a
    failure result carrying any GraphQL ``errors`` GitHub sent. A JSON answer of
    another shape keeps its status and counters; only a body that is not JSON has
    ``status: None``. The body is streamed, and reading stops once it passes
    ``max_bytes`` decoded bytes; that answer becomes an error naming the cap.
    """
    # Conservatively treat an uncheckable document like a mutation. Selecting a named
    # query in a mixed document does not establish that retrying is safe.
    may_write = mutation_refusal(query) is not None
    payload: dict = {'query': query}
    if variables is not None:
        payload['variables'] = variables
    if operation_name is not None:
        payload['operationName'] = operation_name
    handed = Handed.of(credential)
    try:
        resp, content = request_with_backoff(
            handed, 'POST', '/graphql', body=payload, retry=retry, max_bytes=max_bytes, graphql=True
        )
    except RateLimitExhausted as exc:
        error = _graphql_error(exc.status_code, exc.headers, exc.body, (*handed.tokens, *secrets))
        result = _with_retry_after(error, exc)
    except AuthenticationFailed:
        result = failure_result(AUTH_FAILURE)
    except (ValueError, requests.RequestException):
        result = failure_result(_graphql_transport_failure(may_write))
    else:
        result = _graphql_answer(
            resp, content, max_bytes=max_bytes, may_write=may_write, secrets=(*handed.tokens, *secrets)
        )
    return redact_result(result, (*handed.tokens, *secrets))


def _graphql_transport_failure(may_write: bool) -> str:
    """The message for an answer that was not used: a document that may write gets the uncertain-outcome text."""
    return _GRAPHQL_UNKNOWN_OUTCOME if may_write else _TRANSPORT_FAILURE


def _graphql_answer(
    resp: requests.Response, content: bytes | None, *, max_bytes: int, may_write: bool, secrets: tuple[str, ...]
) -> dict:
    """Shape GitHub's answer to a GraphQL request as a result; ``content`` is ``None`` once it passed the cap."""
    if content is None:
        over_cap = (
            f'The GraphQL response is larger than graphqlMaxResponseBytes ({max_bytes} bytes). Select '
            'fewer fields or a smaller page, or raise the cap in the node configuration.'
        )
        if may_write:
            over_cap = f'{over_cap} {_GRAPHQL_UNKNOWN_OUTCOME}'
        return failure_result(over_cap, None, resp.headers)
    body, is_json = _decode_json(content)
    if not resp.ok:
        result = _graphql_error(resp.status_code, resp.headers, body, secrets)
        if may_write and resp.status_code >= 500:
            result['message'] = f'{result["message"].rstrip()} {_GRAPHQL_UNKNOWN_OUTCOME}'
        return result
    if not is_json:
        return failure_result(_graphql_transport_failure(may_write))
    if isinstance(body, dict) and ('data' in body or 'errors' in body):
        result = envelope(resp.status_code, resp.headers, {'data': body.get('data'), 'errors': body.get('errors')})
        result['next_page'] = None
        return result
    # JSON of the wrong shape: keep the status and counters, and GitHub's message if any.
    result = shape_failure(envelope(resp.status_code, resp.headers, None), 'a JSON object with data or errors')
    if isinstance(body, dict) and isinstance(body.get('message'), str):
        result['message'] = _error_message(resp.status_code, body, secrets)
        documentation_url = body.get('documentation_url')
        result['documentation_url'] = documentation_url if isinstance(documentation_url, str) else None
    return result


# ---------------------------------------------------------------------------
# Response cleaners — strip noisy fields (node_id, _links, gravatar, etc.)
# so agents get compact, useful output.
# ---------------------------------------------------------------------------


def clean_user(u: dict | None) -> dict:
    if not isinstance(u, dict):
        return {}
    return {k: u[k] for k in ('login', 'id', 'avatar_url', 'html_url') if k in u}


def clean_label(lbl: dict | None) -> dict:
    if not isinstance(lbl, dict):
        return {}
    return {k: lbl[k] for k in ('id', 'name', 'color', 'description') if k in lbl}


def clean_issue(issue: dict) -> dict:
    return {
        'number': issue.get('number'),
        'title': issue.get('title'),
        'body': issue.get('body'),
        'state': issue.get('state'),
        'labels': [clean_label(lbl) for lbl in (issue.get('labels') or [])],
        'user': clean_user(issue.get('user')),
        'assignees': [clean_user(a) for a in (issue.get('assignees') or [])],
        'created_at': issue.get('created_at'),
        'updated_at': issue.get('updated_at'),
        'closed_at': issue.get('closed_at'),
        'html_url': issue.get('html_url'),
        'comments': issue.get('comments'),
    }


def clean_pr(pr: dict) -> dict:
    head = pr.get('head') or {}
    base = pr.get('base') or {}
    return {
        'number': pr.get('number'),
        'title': pr.get('title'),
        'body': pr.get('body'),
        'state': pr.get('state'),
        'merged': pr.get('merged', False),
        'draft': pr.get('draft', False),
        'head': {'ref': head.get('ref'), 'sha': head.get('sha')},
        'base': {'ref': base.get('ref'), 'sha': base.get('sha')},
        'user': clean_user(pr.get('user')),
        'created_at': pr.get('created_at'),
        'updated_at': pr.get('updated_at'),
        'merged_at': pr.get('merged_at'),
        'html_url': pr.get('html_url'),
        'commits': pr.get('commits'),
        'additions': pr.get('additions'),
        'deletions': pr.get('deletions'),
        'changed_files': pr.get('changed_files'),
    }


def clean_file_entry(f: dict) -> dict:
    return {k: f[k] for k in ('name', 'path', 'type', 'sha', 'size', 'download_url') if k in f}


def clean_commit(c: dict) -> dict:
    commit = c.get('commit') or {}
    author = commit.get('author') or {}
    return {
        'sha': c.get('sha'),
        'message': commit.get('message'),
        'author': author.get('name'),
        'date': author.get('date'),
        'html_url': c.get('html_url'),
    }


def clean_release(r: dict) -> dict:
    return {
        'id': r.get('id'),
        'tag_name': r.get('tag_name'),
        'name': r.get('name'),
        'body': r.get('body'),
        'draft': r.get('draft'),
        'prerelease': r.get('prerelease'),
        'created_at': r.get('created_at'),
        'published_at': r.get('published_at'),
        'html_url': r.get('html_url'),
        'author': clean_user(r.get('author')),
    }


def clean_workflow(w: dict) -> dict:
    return {k: w[k] for k in ('id', 'name', 'path', 'state', 'created_at', 'updated_at', 'html_url') if k in w}


def clean_repo(r: dict) -> dict:
    return {
        'id': r.get('id'),
        'full_name': r.get('full_name'),
        'description': r.get('description'),
        'private': r.get('private'),
        'fork': r.get('fork'),
        'default_branch': r.get('default_branch'),
        'language': r.get('language'),
        'stargazers_count': r.get('stargazers_count'),
        'forks_count': r.get('forks_count'),
        'open_issues_count': r.get('open_issues_count'),
        'created_at': r.get('created_at'),
        'updated_at': r.get('updated_at'),
        'pushed_at': r.get('pushed_at'),
        'html_url': r.get('html_url'),
        'clone_url': r.get('clone_url'),
    }
