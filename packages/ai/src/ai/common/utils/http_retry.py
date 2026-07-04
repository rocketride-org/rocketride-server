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


def post_with_retry(
    url: str,
    *,
    headers: Optional[Dict[str, str]] = None,
    json: Any = None,
    timeout: float = 30,
    max_attempts: int = 4,
    base_delay: float = 2.0,
    max_delay: float = 60.0,
) -> requests.Response:
    """POST with exponential-backoff retry (via ``tenacity``).

    Retries on timeouts, connection errors, and 429 / 5xx responses. Returns the
    successful ``requests.Response``. When all attempts are exhausted the last
    exception is re-raised (``HTTPError`` for a final 429/5xx, ``Timeout`` /
    ``ConnectionError`` for transport failures). 4xx responses other than 429
    are raised immediately without retry.
    """

    def _attempt() -> requests.Response:
        resp = requests.post(url, headers=headers, json=json, timeout=timeout)
        resp.raise_for_status()
        return resp

    retryer = Retrying(
        stop=stop_after_attempt(max_attempts),
        wait=wait_exponential(multiplier=base_delay, max=max_delay),
        retry=retry_if_exception(_is_retryable),
        reraise=True,
    )
    return retryer(_attempt)
