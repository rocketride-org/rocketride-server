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
GitHub REST API v3 client.

Thin wrapper around requests — handles auth, headers, error parsing,
and response normalisation. All tool methods in IInstance call through here.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any
from urllib.parse import parse_qs, urlsplit
import datetime
import time

import jwt
import requests
from tenacity import RetryCallState, Retrying, retry_if_exception_type, stop_after_attempt, wait_exponential


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
    jwt_token = sign_app_jwt(app_id, private_key_pem)
    headers = {
        'Authorization': f'Bearer {jwt_token}',
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
    }
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


def call_with_metadata(
    token: str,
    method: str,
    path: str,
    *,
    params: dict | None = None,
    body: dict | None = None,
) -> dict:
    """The same call, returned as the result envelope the repository-read tools use.

    ``envelope`` of the status, the rate-limit counters, the next page and the parsed
    body (an empty object for 204). HTTP errors raise as ``call`` raises them; the
    caller turns them into failure results.
    """
    resp = _exchange(token, method, path, params=params, body=body)
    return envelope(resp.status_code, resp.headers, {} if resp.status_code == 204 else resp.json())


def _exchange(
    token: str,
    method: str,
    path: str,
    *,
    params: dict | None = None,
    body: dict | None = None,
) -> requests.Response:
    """Send one authenticated request with the node's retry policy and return a 2xx response.

    Shared by ``call`` and ``call_with_metadata``, which only differ in what they return.
    A rate limit is retried (at most three attempts with bounded waits); any other
    non-2xx answer raises ``GitHubAPIError``, and a transport failure ``ValueError``.
    """
    headers = {
        'Authorization': f'Bearer {token}',
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
    }

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


def _error_message(exc: GitHubAPIError, secrets: tuple[str, ...] = ()) -> str:
    """Compose a public message from the parsed error body, never from raw response text.

    The secrets are redacted before the cap, so a credential GitHub echoed across the
    cut cannot leave a prefix behind.
    """
    body = exc.body
    if not isinstance(body, dict) or not isinstance(body.get('message'), str):
        return f'GitHub returned HTTP {exc.status_code} without a JSON error body.'
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
    if isinstance(value, str):
        for secret in sorted((s for s in secrets if s), key=len, reverse=True):
            value = value.replace(secret, '[REDACTED]')
        return value
    if isinstance(value, dict):
        return {redact_result(k, secrets): redact_result(v, secrets) for k, v in value.items()}
    if isinstance(value, list):
        return [redact_result(v, secrets) for v in value]
    return value


def get_result(token: str, path: str, *, params: dict | None = None, secrets: tuple[str, ...] = ()) -> dict:
    """GET with the result envelope: HTTP errors become results and credentials are redacted.

    ``token`` and ``secrets`` (the node's other credentials) are redacted from the whole
    result, and from an error message before it is capped. Transport and JSON failures
    have ``status: None`` and a fixed message, so exception text never reaches a client.
    Retries follow ``call`` (at most three attempts with bounded waits).
    """
    secrets = (token, *secrets)
    try:
        result = call_with_metadata(token, 'GET', path, params=params)
    except GitHubAPIError as exc:
        result = failure_result(_error_message(exc, secrets), exc.status_code, exc.headers)
        if isinstance(exc.body, dict) and isinstance(exc.body.get('documentation_url'), str):
            result['documentation_url'] = exc.body['documentation_url']
    except (ValueError, requests.RequestException):
        result = failure_result('GitHub request failed or returned invalid JSON. Check connectivity and retry.')
    return redact_result(result, secrets)


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
