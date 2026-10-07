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
"""HTTP client for the ``POST /v1/systemone`` decision API."""

from __future__ import annotations

import time
from typing import Callable

import httpx

from .limits import encode_json

RETRY_STATUSES = frozenset({429, 500, 502, 503, 504, 529})
MAX_RETRY_DELAY = 60.0


class SystemOneError(Exception):
    """A System One call failed; ``kind`` says how the caller should treat it."""

    def __init__(self, kind: str, message: str, *, status: int | None = None, request_id: str | None = None):
        """Create the error."""
        super().__init__(message)
        self.kind = kind
        self.status = status
        self.request_id = request_id


def _kind_for(status: int, text: str) -> str:
    if status in (401, 403):
        return 'auth'
    if status == 404:
        return 'not_found'
    if status == 413 or 'max_tokens_exceeded' in text:
        return 'too_large'
    if status == 429:
        return 'rate_limited'
    if status >= 500:
        return 'server'
    return 'invalid'


class SystemOneClient:
    """Synchronous client for one System One backend."""

    def __init__(
        self,
        base_url: str,
        api_key: str | None = None,
        *,
        timeout: float = 30.0,
        max_retries: int = 3,
        backoff: float = 0.5,
        transport: httpx.BaseTransport | None = None,
        sleep: Callable[[float], None] = time.sleep,
    ):
        """Create a client; ``transport`` is injectable for tests."""
        base = base_url.rstrip('/')
        self._endpoint = f'{base}/systemone' if base.endswith('/v1') else f'{base}/v1/systemone'
        headers = {'Content-Type': 'application/json'}
        if api_key:
            headers['Authorization'] = f'Bearer {api_key}'
        self._http = httpx.Client(headers=headers, timeout=timeout, transport=transport)
        self._max_retries = max_retries
        self._backoff = backoff
        self._sleep = sleep
        self.last_request_id: str | None = None

    @property
    def endpoint(self) -> str:
        """Return the full ``/v1/systemone`` URL."""
        return self._endpoint

    def close(self) -> None:
        """Close the underlying HTTP connection pool."""
        self._http.close()

    def _delay(self, response: httpx.Response | None, attempt: int) -> float:
        if response is not None:
            if response.headers.get('retry-after-ms'):
                try:
                    ms = float(response.headers['retry-after-ms'])
                    if 0 <= ms < float('inf'):
                        return min(ms / 1000, MAX_RETRY_DELAY)
                except (ValueError, OverflowError):
                    pass
            if response.headers.get('retry-after'):
                try:
                    seconds = float(response.headers['retry-after'])
                    if 0 <= seconds < float('inf'):
                        return min(seconds, MAX_RETRY_DELAY)
                except (ValueError, OverflowError):
                    pass
        delay = self._backoff * (2**attempt)
        return min(delay, MAX_RETRY_DELAY)

    def decide(self, model: str, state, questions: dict) -> dict:
        """Send one state and its questions; return the response JSON."""
        body = {'model': model, 'state': state, 'questions': questions}
        content = encode_json(body)
        attempt = 0
        while True:
            response = None
            try:
                response = self._http.post(self._endpoint, content=content)
            except httpx.TransportError as exc:
                if attempt >= self._max_retries:
                    raise SystemOneError('network', f'{self._endpoint}: {exc}') from exc
            else:
                self.last_request_id = response.headers.get('x-typesafe-request-id')
                if response.status_code < 400:
                    try:
                        return response.json()
                    except ValueError as exc:
                        raise SystemOneError(
                            'protocol', 'backend returned non-JSON', status=response.status_code
                        ) from exc
                if response.status_code not in RETRY_STATUSES or attempt >= self._max_retries:
                    text = response.text
                    raise SystemOneError(
                        _kind_for(response.status_code, text),
                        f'{response.status_code} from {self._endpoint}: {text[:500]}',
                        status=response.status_code,
                        request_id=response.headers.get('x-typesafe-request-id'),
                    )
            self._sleep(self._delay(response, attempt))
            attempt += 1
