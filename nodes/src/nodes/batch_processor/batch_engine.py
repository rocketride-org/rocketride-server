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
Batch processing engine.

Fans out a list of work items with bounded concurrency, per-item retry,
rate limiting, and progress tracking.  Each item is processed by a
caller-supplied ``process_fn`` coroutine; failures on one item never
prevent other items from completing (unless ``stop_on_failure`` is set).
"""

from __future__ import annotations

import asyncio
import csv
import io
import json
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable, Coroutine, Dict, List, Optional


# ---------------------------------------------------------------------------
# Public data types
# ---------------------------------------------------------------------------


class ItemStatus(str, Enum):
    """Outcome of a single batch item."""

    SUCCESS = 'success'
    FAILED = 'failed'
    SKIPPED = 'skipped'


@dataclass
class ItemResult:
    """Result envelope for one item in the batch."""

    index: int
    status: ItemStatus
    input: Any  # noqa: A003 — mirrors the original item
    output: Any = None
    error: Optional[str] = None
    attempts: int = 0


@dataclass
class BatchProgress:
    """Mutable progress counter shared across worker tasks."""

    total: int = 0
    completed: int = 0
    failed: int = 0
    skipped: int = 0

    def as_dict(self) -> Dict[str, int]:
        return {
            'total': self.total,
            'completed': self.completed,
            'failed': self.failed,
            'skipped': self.skipped,
        }


@dataclass
class BatchConfig:
    """All tunables for a batch run."""

    concurrency: int = 4
    retry_count: int = 2
    retry_delay_ms: int = 500
    rate_limit_per_second: int = 10
    input_format: str = 'json_array'
    stop_on_failure: bool = False


@dataclass
class BatchResult:
    """Final output returned to the caller."""

    items: List[ItemResult] = field(default_factory=list)
    progress: BatchProgress = field(default_factory=BatchProgress)

    def as_dict(self) -> Dict[str, Any]:
        return {
            'progress': self.progress.as_dict(),
            'items': [
                {
                    'index': r.index,
                    'status': r.status.value,
                    'input': r.input,
                    'output': r.output,
                    'error': r.error,
                    'attempts': r.attempts,
                }
                for r in self.items
            ],
        }


# ---------------------------------------------------------------------------
# Input parsing
# ---------------------------------------------------------------------------


def parse_input(raw: str, fmt: str) -> List[Any]:
    """Parse *raw* text into a list of work items according to *fmt*."""
    fmt = (fmt or 'json_array').strip().lower()

    if fmt == 'json_array':
        return _parse_json_array(raw)
    if fmt == 'csv':
        return _parse_csv(raw)
    if fmt == 'line_delimited':
        return _parse_lines(raw)

    raise ValueError(f'Unsupported input format: {fmt!r}')


def _parse_json_array(raw: str) -> List[Any]:
    data = json.loads(raw)
    if isinstance(data, list):
        return data
    raise ValueError('Expected a JSON array at the top level')


def _parse_csv(raw: str) -> List[Dict[str, str]]:
    reader = csv.DictReader(io.StringIO(raw))
    return [dict(row) for row in reader]


def _parse_lines(raw: str) -> List[str]:
    return [line for line in raw.splitlines() if line.strip()]


# ---------------------------------------------------------------------------
# Token-bucket rate limiter
# ---------------------------------------------------------------------------


class _TokenBucket:
    """Simple async token-bucket rate limiter."""

    def __init__(self, rate: float) -> None:
        self._rate = rate
        self._tokens = rate
        self._last = time.monotonic()

    async def acquire(self) -> None:
        if self._rate <= 0:
            return  # unlimited
        while True:
            now = time.monotonic()
            elapsed = now - self._last
            self._last = now
            self._tokens = min(self._rate, self._tokens + elapsed * self._rate)
            if self._tokens >= 1.0:
                self._tokens -= 1.0
                return
            # Sleep just long enough for one token to be available.
            await asyncio.sleep(1.0 / self._rate)


# ---------------------------------------------------------------------------
# Core engine
# ---------------------------------------------------------------------------

# Type alias for the per-item processor function.
ProcessFn = Callable[[Any], Coroutine[Any, Any, Any]]


async def run_batch(
    items: List[Any],
    process_fn: ProcessFn,
    config: BatchConfig,
) -> BatchResult:
    """Execute *process_fn* over every element of *items* with bounded
    concurrency, retry, and rate limiting.

    Returns a :class:`BatchResult` that always contains one
    :class:`ItemResult` per input item, regardless of success or failure.
    """
    progress = BatchProgress(total=len(items))
    results: List[ItemResult] = [None] * len(items)  # type: ignore[list-item]
    semaphore = asyncio.Semaphore(max(1, config.concurrency))
    bucket = _TokenBucket(config.rate_limit_per_second)
    abort = asyncio.Event()

    async def _worker(index: int, item: Any) -> None:
        if abort.is_set():
            result = ItemResult(index=index, status=ItemStatus.SKIPPED, input=item)
            progress.skipped += 1
            results[index] = result
            return

        attempts = 0
        last_error: Optional[str] = None

        for attempt in range(1, config.retry_count + 2):  # +2 because first try is not a "retry"
            attempts = attempt
            await bucket.acquire()
            async with semaphore:
                if abort.is_set():
                    result = ItemResult(index=index, status=ItemStatus.SKIPPED, input=item, attempts=attempts)
                    progress.skipped += 1
                    results[index] = result
                    return
                try:
                    output = await process_fn(item)
                    result = ItemResult(
                        index=index,
                        status=ItemStatus.SUCCESS,
                        input=item,
                        output=output,
                        attempts=attempts,
                    )
                    progress.completed += 1
                    results[index] = result
                    return
                except Exception as exc:  # noqa: BLE001
                    last_error = str(exc)

            # Exponential backoff before retry.
            if attempt <= config.retry_count:
                delay_s = (config.retry_delay_ms / 1000.0) * (2 ** (attempt - 1))
                await asyncio.sleep(delay_s)

        # All retries exhausted.
        result = ItemResult(
            index=index,
            status=ItemStatus.FAILED,
            input=item,
            error=last_error,
            attempts=attempts,
        )
        progress.failed += 1
        results[index] = result

        if config.stop_on_failure:
            abort.set()

    tasks = [asyncio.create_task(_worker(i, item)) for i, item in enumerate(items)]
    await asyncio.gather(*tasks)

    return BatchResult(items=results, progress=progress)
