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
Async batch processing engine.

Provides:
- Semaphore-based concurrency control
- Token-bucket rate limiter
- Exponential-backoff retry per item
- Per-item error isolation (or stop-on-failure mode)
- JSON array, CSV, and line-delimited input parsing
"""

from __future__ import annotations

import asyncio
import csv
import io
import json
import time
from typing import Any, Callable, Dict, List


class _TokenBucketRateLimiter:
    """Simple async token-bucket rate limiter."""

    def __init__(self, tokens_per_second: int) -> None:
        self._rate = float(tokens_per_second)
        self._max_tokens = float(tokens_per_second)
        self._tokens = float(tokens_per_second)
        self._last_refill = time.monotonic()
        self._lock = asyncio.Lock()

    async def acquire(self) -> None:
        while True:
            async with self._lock:
                self._refill()
                if self._tokens >= 1.0:
                    self._tokens -= 1.0
                    return
            await asyncio.sleep(1.0 / self._rate)

    def _refill(self) -> None:
        now = time.monotonic()
        elapsed = now - self._last_refill
        self._last_refill = now
        self._tokens = min(self._max_tokens, self._tokens + elapsed * self._rate)


class BatchAbortError(Exception):
    """Raised when stop_on_failure triggers an early abort."""


class BatchEngine:
    """Batch processing engine exposed as a tool to agents."""

    def __init__(
        self,
        *,
        server_name: str,
        concurrency: int,
        retry_count: int,
        retry_delay_ms: int,
        rate_limit_per_second: int,
        input_format: str,
        stop_on_failure: bool,
    ) -> None:
        """Initialize the batch engine with the given configuration."""
        self._server_name = server_name
        self._concurrency = max(concurrency, 1)
        self._retry_count = max(retry_count, 0)
        self._retry_delay_ms = max(retry_delay_ms, 0)
        self._rate_limit_per_second = max(rate_limit_per_second, 0)
        self._input_format = input_format
        self._stop_on_failure = stop_on_failure

        self._tool_schema = {
            'name': f'{server_name}.batch_process',
            'description': ('Process a batch of items. Accepts a payload string containing the items in the configured format (JSON array, CSV, or line-delimited). An optional process_fn field can provide a Python expression applied to each item. Returns a JSON object with results and summary statistics.'),
            'parameters': {
                'type': 'object',
                'properties': {
                    'payload': {
                        'type': 'string',
                        'description': 'The batch input data as a string.',
                    },
                    'process_fn': {
                        'type': 'string',
                        'description': 'Optional Python expression to apply to each item. The variable `item` holds the current item.',
                    },
                },
                'required': ['payload'],
            },
        }

    @property
    def tool_schema(self) -> dict:
        return self._tool_schema

    def handle_invoke(self, param: Any) -> Any:  # noqa: ANN401
        if isinstance(param, str):
            param = json.loads(param)

        payload = param.get('payload', '')
        process_fn_expr = param.get('process_fn')

        items = self._parse_input(payload)

        process_fn: Callable[[Any], Any] | None = None
        if process_fn_expr:
            process_fn = self._build_process_fn(process_fn_expr)

        results = asyncio.run(self._run_batch(items, process_fn))

        succeeded = sum(1 for r in results if r['status'] == 'success')
        failed = sum(1 for r in results if r['status'] == 'error')
        skipped = sum(1 for r in results if r['status'] == 'skipped')

        return {
            'results': results,
            'summary': {
                'total': len(results),
                'succeeded': succeeded,
                'failed': failed,
                'skipped': skipped,
            },
        }

    def _parse_input(self, payload: str) -> List[Any]:
        if self._input_format == 'json_array':
            return self._parse_json_array(payload)
        elif self._input_format == 'csv':
            return self._parse_csv(payload)
        elif self._input_format == 'lines':
            return self._parse_lines(payload)
        else:
            raise ValueError(f'Unknown input format: {self._input_format}')

    @staticmethod
    def _parse_json_array(payload: str) -> List[Any]:
        data = json.loads(payload)
        if not isinstance(data, list):
            raise ValueError('JSON input must be an array')
        return data

    @staticmethod
    def _parse_csv(payload: str) -> List[Dict[str, str]]:
        reader = csv.DictReader(io.StringIO(payload))
        return [row for row in reader]

    @staticmethod
    def _parse_lines(payload: str) -> List[str]:
        return [line for line in payload.splitlines() if line.strip()]

    @staticmethod
    def _build_process_fn(expr: str) -> Callable[[Any], Any]:
        code = compile(expr, '<process_fn>', 'eval')

        def fn(item: Any) -> Any:  # noqa: ANN401
            return eval(code, {'__builtins__': {}}, {'item': item})  # noqa: S307

        return fn

    async def _run_batch(
        self,
        items: List[Any],
        process_fn: Callable[[Any], Any] | None,
    ) -> List[Dict[str, Any]]:
        semaphore = asyncio.Semaphore(self._concurrency)
        rate_limiter = _TokenBucketRateLimiter(self._rate_limit_per_second) if self._rate_limit_per_second > 0 else None
        abort = asyncio.Event()
        results: List[Dict[str, Any]] = [{'index': i, 'status': 'pending', 'result': None, 'error': None} for i in range(len(items))]

        async def process_item(index: int, item: Any) -> None:  # noqa: ANN401
            if abort.is_set():
                results[index] = {'index': index, 'status': 'skipped', 'result': None, 'error': 'Aborted due to stop_on_failure'}
                return

            async with semaphore:
                if rate_limiter:
                    await rate_limiter.acquire()

                last_error: str | None = None
                for attempt in range(self._retry_count + 1):
                    if abort.is_set():
                        results[index] = {'index': index, 'status': 'skipped', 'result': None, 'error': 'Aborted due to stop_on_failure'}
                        return
                    try:
                        result = process_fn(item) if process_fn else item
                        results[index] = {'index': index, 'status': 'success', 'result': result, 'error': None}
                        return
                    except Exception as e:
                        last_error = str(e)
                        if attempt < self._retry_count:
                            delay_s = (self._retry_delay_ms / 1000.0) * (2**attempt)
                            await asyncio.sleep(delay_s)

                results[index] = {'index': index, 'status': 'error', 'result': None, 'error': last_error}
                if self._stop_on_failure:
                    abort.set()

        tasks = [asyncio.create_task(process_item(i, item)) for i, item in enumerate(items)]
        await asyncio.gather(*tasks)
        return results
