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
Batch Processor tool node - global (shared) state.

Reads the node configuration and creates a ``BatchEngine`` that exposes a
single ``batch_process`` tool for agent invocation.  The config panel provides
concurrency, retry, rate-limiting, and input-format settings.
"""

from __future__ import annotations

from ai.common.config import Config
from rocketlib import IGlobalBase, OPEN_MODE, warning

from .batch_engine import BatchEngine


class IGlobal(IGlobalBase):
    """Global state for batch_processor."""

    engine: BatchEngine | None = None

    def beginGlobal(self) -> None:
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return

        cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)

        server_name = str((cfg.get('serverName') or 'batch')).strip()

        try:
            self.engine = BatchEngine(
                server_name=server_name,
                concurrency=int(cfg.get('concurrency', 5)),
                retry_count=int(cfg.get('retryCount', 3)),
                retry_delay_ms=int(cfg.get('retryDelayMs', 1000)),
                rate_limit_per_second=int(cfg.get('rateLimitPerSecond', 0)),
                input_format=str(cfg.get('inputFormat', 'json_array')),
                stop_on_failure=bool(cfg.get('stopOnFailure', False)),
            )
        except Exception as e:
            warning(str(e))
            raise

    def validateConfig(self) -> None:
        try:
            cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
            concurrency = int(cfg.get('concurrency', 5))
            if concurrency < 1:
                warning('concurrency must be at least 1')
            retry_count = int(cfg.get('retryCount', 3))
            if retry_count < 0:
                warning('retryCount must be non-negative')
            rate_limit = int(cfg.get('rateLimitPerSecond', 0))
            if rate_limit < 0:
                warning('rateLimitPerSecond must be non-negative')
            input_format = str(cfg.get('inputFormat', 'json_array'))
            if input_format not in ('json_array', 'csv', 'lines'):
                warning(f'Unknown inputFormat: {input_format}')
        except Exception as e:
            warning(str(e))

    def endGlobal(self) -> None:
        self.engine = None
