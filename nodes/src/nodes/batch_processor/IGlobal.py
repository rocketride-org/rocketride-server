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
Batch processor node - global (shared) state.

Reads the node configuration and builds a :class:`BatchConfig` that the
instance-level ``invoke`` method will use to drive :func:`run_batch`.
"""

from __future__ import annotations

from ai.common.config import Config
from rocketlib import IGlobalBase, OPEN_MODE, warning

from .batch_engine import BatchConfig


class IGlobal(IGlobalBase):
    """Global state for batch_processor."""

    config: BatchConfig | None = None

    def beginGlobal(self) -> None:
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return

        cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)

        try:
            self.config = BatchConfig(
                concurrency=_int(cfg, 'concurrency', 4, lo=1, hi=64),
                retry_count=_int(cfg, 'retryCount', 2, lo=0, hi=10),
                retry_delay_ms=_int(cfg, 'retryDelayMs', 500, lo=0, hi=30000),
                rate_limit_per_second=_int(cfg, 'rateLimitPerSecond', 10, lo=0, hi=1000),
                input_format=str(cfg.get('inputFormat') or 'json_array').strip(),
                stop_on_failure=bool(cfg.get('stopOnFailure')),
            )
        except Exception as e:
            warning(str(e))
            raise

    def validateConfig(self) -> None:
        try:
            cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
            concurrency = _int(cfg, 'concurrency', 4, lo=1, hi=64)
            if concurrency < 1:
                warning('concurrency must be at least 1')
        except Exception as e:
            warning(str(e))

    def endGlobal(self) -> None:
        self.config = None


def _int(cfg: dict, key: str, default: int, *, lo: int, hi: int) -> int:
    """Extract and clamp an integer config value."""
    raw = cfg.get(key)
    if raw is None:
        return default
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return default
    return max(lo, min(value, hi))
