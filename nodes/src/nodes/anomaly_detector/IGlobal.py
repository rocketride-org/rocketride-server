# =============================================================================
# MIT License
# Copyright (c) 2026 RocketRide Inc.
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
Anomaly detector node - global (shared) state.

Creates and holds an ``AnomalyDetector`` instance that is shared across
all pipeline threads so the sliding window accumulates observations from
every invocation.
"""

from __future__ import annotations

from ai.common.config import Config
from rocketlib import IGlobalBase, OPEN_MODE, warning

from .detector import AnomalyDetector, DetectorConfig, Method


class IGlobal(IGlobalBase):
    """Global state for anomaly_detector."""

    detector: AnomalyDetector | None = None

    def beginGlobal(self) -> None:
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return

        cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)

        method_raw = str(cfg.get('method') or 'zscore').strip().lower()
        try:
            method = Method(method_raw)
        except ValueError:
            warning(f'anomaly_detector: unknown method {method_raw!r}, falling back to zscore')
            method = Method.ZSCORE

        sensitivity = _float(cfg.get('sensitivity'), 2.0, 0.1, 10.0)
        window_size = _int(cfg.get('windowSize'), 100, 10, 10000)
        warning_mult = _float(cfg.get('warningThreshold'), 1.5, 1.0, 5.0)
        critical_mult = _float(cfg.get('criticalThreshold'), 2.0, 1.0, 10.0)

        self.detector = AnomalyDetector(
            config=DetectorConfig(
                method=method,
                sensitivity=sensitivity,
                window_size=window_size,
                warning_multiplier=warning_mult,
                critical_multiplier=critical_mult,
            )
        )

    def endGlobal(self) -> None:
        self.detector = None


# ======================================================================
# Config helpers
# ======================================================================


def _float(raw: object, default: float, lo: float, hi: float) -> float:
    if raw is None:
        return default
    try:
        v = float(raw)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return default
    return max(lo, min(v, hi))


def _int(raw: object, default: int, lo: int, hi: int) -> int:
    if raw is None:
        return default
    try:
        v = int(raw)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return default
    return max(lo, min(v, hi))
