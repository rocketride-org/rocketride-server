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
Batch processor node instance.

On ``invoke``, parses the incoming payload into individual work items,
fans them out through the batch engine, and returns the collected results
with per-item status.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

from rocketlib import IInstanceBase

from .IGlobal import IGlobal
from .batch_engine import BatchConfig, parse_input, run_batch


class IInstance(IInstanceBase):
    IGlobal: IGlobal

    def invoke(self, param: Any) -> Any:  # noqa: ANN401
        config = getattr(self.IGlobal, 'config', None)
        if config is None:
            raise RuntimeError('batch_processor: engine not initialized')

        # Determine the raw payload and optional per-call overrides.
        if isinstance(param, dict):
            raw_input = param.get('input', '')
            process_template = param.get('processTemplate')
            # Allow per-call config overrides.
            config = _apply_overrides(config, param)
        else:
            raw_input = str(param)
            process_template = None

        # If the input is already a list, use it directly.
        if isinstance(raw_input, list):
            items = raw_input
        else:
            items = parse_input(str(raw_input), config.input_format)

        if not items:
            return json.dumps(
                {
                    'progress': {'total': 0, 'completed': 0, 'failed': 0, 'skipped': 0},
                    'items': [],
                }
            )

        # Build the per-item processor.  When a ``processTemplate`` is
        # provided (a string with ``{item}`` placeholders), each item is
        # rendered into it before being returned as the "output".  This is
        # useful for simple transformation pipelines.  For real downstream
        # processing the caller would wire additional pipeline nodes after
        # this one.
        async def _process_item(item: Any) -> Any:
            if process_template and isinstance(process_template, str):
                rendered = process_template.replace('{item}', json.dumps(item) if not isinstance(item, str) else item)
                return rendered
            # Identity pass-through — the downstream pipeline node handles
            # the actual work.
            return item

        # Run the batch engine.  We create a fresh event loop if one is
        # not already running (common in synchronous node execution).
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            loop = None

        if loop and loop.is_running():
            # We are inside an existing event loop (e.g. the engine's
            # async runtime).  Schedule a new task so we don't block.
            import concurrent.futures

            with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
                result = pool.submit(asyncio.run, run_batch(items, _process_item, config)).result()
        else:
            result = asyncio.run(run_batch(items, _process_item, config))

        return json.dumps(result.as_dict())


def _apply_overrides(base: BatchConfig, param: dict) -> BatchConfig:
    """Return a copy of *base* with any per-call overrides merged in."""
    return BatchConfig(
        concurrency=_opt_int(param, 'concurrency', base.concurrency),
        retry_count=_opt_int(param, 'retryCount', base.retry_count),
        retry_delay_ms=_opt_int(param, 'retryDelayMs', base.retry_delay_ms),
        rate_limit_per_second=_opt_int(param, 'rateLimitPerSecond', base.rate_limit_per_second),
        input_format=str(param.get('inputFormat', base.input_format)),
        stop_on_failure=bool(param.get('stopOnFailure', base.stop_on_failure)),
    )


def _opt_int(d: dict, key: str, default: int) -> int:
    raw = d.get(key)
    if raw is None:
        return default
    try:
        return int(raw)
    except (TypeError, ValueError):
        return default
