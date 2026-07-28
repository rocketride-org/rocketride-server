"""Shared HTTP request helpers with tenacity-based retry.

Tool nodes that POST to third-party APIs (tool_tavily, and — via the next
dedup PR — tool_exa_search / tool_xtrace_memory) should use this instead of a
hand-rolled retry loop. ``tenacity`` is the repo's standard retry mechanism.
"""

from __future__ import annotations

from typing import Any, Dict, Optional

import requests
from tenacity import Retrying, retry_if_exception, stop_after_attempt, wait_exponential


def _is_retryable(exc: BaseException) -> bool:
    """Retry transient transport failures and 429 / 5xx responses only."""
    if isinstance(exc, (requests.exceptions.Timeout, requests.exceptions.ConnectionError)):
        return True
    if isinstance(exc, requests.exceptions.HTTPError):
        resp = exc.response
        return resp is not None and (resp.status_code == 429 or 500 <= resp.status_code < 600)
    return False


def _retrying(max_attempts: int, base_delay: float, max_delay: float) -> Retrying:
    """Shared tenacity retry policy so POST and GET helpers can't drift apart."""
    return Retrying(
        stop=stop_after_attempt(max_attempts),
        wait=wait_exponential(multiplier=base_delay, max=max_delay),
        retry=retry_if_exception(_is_retryable),
        reraise=True,
    )


def post_with_retry(
    url: str,
    *,
    headers: Optional[Dict[str, str]] = None,
    json: Any = None,
    data: Any = None,
    files: Any = None,
    timeout: float = 30,
    max_attempts: int = 4,
    base_delay: float = 2.0,
    max_delay: float = 60.0,
) -> requests.Response:
    """POST with exponential-backoff retry (via ``tenacity``).

    Pass ``json`` for a JSON body, or ``data`` / ``files`` for a form / multipart
    body (e.g. a file-upload or form endpoint); all three are forwarded to
    ``requests.post`` unchanged. Retries on timeouts, connection errors, and
    429 / 5xx responses. Returns the successful ``requests.Response``. When all
    attempts are exhausted the last exception is re-raised (``HTTPError`` for a
    final 429/5xx, ``Timeout`` / ``ConnectionError`` for transport failures).
    4xx responses other than 429 are raised immediately without retry.
    """

    def _attempt() -> requests.Response:
        resp = requests.post(url, headers=headers, json=json, data=data, files=files, timeout=timeout)
        resp.raise_for_status()
        return resp

    return _retrying(max_attempts, base_delay, max_delay)(_attempt)


def request_with_retry(
    method: str,
    url: str,
    *,
    headers: Optional[Dict[str, str]] = None,
    params: Any = None,
    json: Any = None,
    data: Any = None,
    files: Any = None,
    timeout: float = 30,
    max_attempts: int = 4,
    base_delay: float = 2.0,
    max_delay: float = 60.0,
) -> requests.Response:
    """Issue any HTTP method with the same retry policy as POST/GET.

    For verbs the dedicated helpers don't cover — PATCH, DELETE, PUT — as used
    by REST APIs that map updates and deletes onto them. ``method`` is passed
    to ``requests.request`` unchanged. Same policy as :func:`post_with_retry`:
    retries timeouts, connection errors, and 429 / 5xx; other 4xx raise
    immediately.

    Note that retrying is only safe for idempotent verbs. DELETE and PUT are
    idempotent by definition, and PATCH is idempotent for the value-set updates
    this is used for; do not route a non-idempotent POST through here — use
    :func:`post_with_retry`, which callers already expect to retry.
    """

    def _attempt() -> requests.Response:
        resp = requests.request(
            method,
            url,
            headers=headers,
            params=params,
            json=json,
            data=data,
            files=files,
            timeout=timeout,
        )
        resp.raise_for_status()
        return resp

    return _retrying(max_attempts, base_delay, max_delay)(_attempt)


def get_with_retry(
    url: str,
    *,
    headers: Optional[Dict[str, str]] = None,
    params: Any = None,
    timeout: float = 30,
    max_attempts: int = 4,
    base_delay: float = 2.0,
    max_delay: float = 60.0,
) -> requests.Response:
    """GET with exponential-backoff retry (via ``tenacity``).

    Same policy as :func:`post_with_retry` (shared ``_retrying`` / ``_is_retryable``):
    retries timeouts, connection errors, and 429 / 5xx responses; other 4xx are raised
    immediately. Returns the successful ``requests.Response``; the last exception is
    re-raised when all attempts are exhausted.
    """

    def _attempt() -> requests.Response:
        resp = requests.get(url, headers=headers, params=params, timeout=timeout)
        resp.raise_for_status()
        return resp

    return _retrying(max_attempts, base_delay, max_delay)(_attempt)
