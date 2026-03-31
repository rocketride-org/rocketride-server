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
Statistical anomaly detection engine.

Supports three detection methods:
- **z-score**: flags values whose z-score exceeds the sensitivity threshold.
- **IQR**: flags values outside ``Q1 - k*IQR .. Q3 + k*IQR``.
- **rolling_avg**: flags values whose deviation from the rolling mean
  exceeds ``sensitivity * rolling_std``.

A sliding window of the most recent observations is maintained so the
baseline adapts over time.
"""

from __future__ import annotations

import math
import threading
from collections import deque
from dataclasses import dataclass, field
from enum import Enum
from typing import Deque, List


class Severity(str, Enum):
    """Anomaly severity levels."""

    NONE = 'none'
    INFO = 'info'
    WARNING = 'warning'
    CRITICAL = 'critical'


class Method(str, Enum):
    """Supported detection methods."""

    ZSCORE = 'zscore'
    IQR = 'iqr'
    ROLLING_AVG = 'rolling_avg'


@dataclass
class AnomalyResult:
    """Result of a single anomaly check."""

    value: float
    is_anomaly: bool
    severity: Severity
    score: float = 0.0
    method: str = ''
    baseline_mean: float = 0.0
    baseline_std: float = 0.0
    message: str = ''


@dataclass
class DetectorConfig:
    """Immutable configuration for an ``AnomalyDetector``."""

    method: Method = Method.ZSCORE
    sensitivity: float = 2.0
    window_size: int = 100
    warning_multiplier: float = 1.5
    critical_multiplier: float = 2.0


@dataclass
class AnomalyDetector:
    """Thread-safe sliding-window anomaly detector."""

    config: DetectorConfig = field(default_factory=DetectorConfig)
    _window: Deque[float] = field(default_factory=deque, init=False, repr=False)
    _lock: threading.Lock = field(default_factory=threading.Lock, init=False, repr=False)

    def __post_init__(self) -> None:  # noqa: D105
        self._window = deque(maxlen=self.config.window_size)

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def observe(self, value: float) -> AnomalyResult:
        """Record *value* and return an ``AnomalyResult``.

        The value is always appended to the sliding window regardless of
        whether it is anomalous.
        """
        with self._lock:
            result = self._evaluate(value)
            self._window.append(value)
            return result

    def reset(self) -> None:
        """Clear the sliding window."""
        with self._lock:
            self._window.clear()

    @property
    def window_values(self) -> List[float]:
        """Return a snapshot of the current window (mainly for testing)."""
        with self._lock:
            return list(self._window)

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _evaluate(self, value: float) -> AnomalyResult:
        """Evaluate *value* against the current baseline."""
        if len(self._window) < 2:
            return AnomalyResult(
                value=value,
                is_anomaly=False,
                severity=Severity.NONE,
                method=self.config.method.value,
                message='insufficient data for anomaly detection',
            )

        method = self.config.method
        if method == Method.ZSCORE:
            return self._zscore(value)
        if method == Method.IQR:
            return self._iqr(value)
        return self._rolling_avg(value)

    # -- z-score -------------------------------------------------------

    def _zscore(self, value: float) -> AnomalyResult:
        mean, std = _mean_std(self._window)
        if std == 0:
            return self._no_variance_result(value, mean)

        z = abs(value - mean) / std
        severity = self._classify(z)
        return AnomalyResult(
            value=value,
            is_anomaly=severity != Severity.NONE,
            severity=severity,
            score=z,
            method='zscore',
            baseline_mean=mean,
            baseline_std=std,
            message=f'z-score {z:.3f} (threshold {self.config.sensitivity})',
        )

    # -- IQR -----------------------------------------------------------

    def _iqr(self, value: float) -> AnomalyResult:
        mean, std = _mean_std(self._window)
        sorted_vals = sorted(self._window)
        q1 = _percentile(sorted_vals, 25)
        q3 = _percentile(sorted_vals, 75)
        iqr = q3 - q1

        if iqr == 0:
            return self._no_variance_result(value, mean)

        lower = q1 - self.config.sensitivity * iqr
        upper = q3 + self.config.sensitivity * iqr
        deviation = 0.0
        if value < lower:
            deviation = (lower - value) / iqr
        elif value > upper:
            deviation = (value - upper) / iqr

        severity = self._classify(deviation)
        return AnomalyResult(
            value=value,
            is_anomaly=severity != Severity.NONE,
            severity=severity,
            score=deviation,
            method='iqr',
            baseline_mean=mean,
            baseline_std=std,
            message=f'IQR deviation {deviation:.3f} (bounds [{lower:.2f}, {upper:.2f}])',
        )

    # -- rolling average -----------------------------------------------

    def _rolling_avg(self, value: float) -> AnomalyResult:
        mean, std = _mean_std(self._window)
        if std == 0:
            return self._no_variance_result(value, mean)

        deviation = abs(value - mean) / std
        severity = self._classify(deviation)
        return AnomalyResult(
            value=value,
            is_anomaly=severity != Severity.NONE,
            severity=severity,
            score=deviation,
            method='rolling_avg',
            baseline_mean=mean,
            baseline_std=std,
            message=f'rolling-avg deviation {deviation:.3f} (threshold {self.config.sensitivity})',
        )

    # -- severity classification ---------------------------------------

    def _classify(self, score: float) -> Severity:
        crit = self.config.sensitivity * self.config.critical_multiplier
        warn = self.config.sensitivity * self.config.warning_multiplier
        if score >= crit:
            return Severity.CRITICAL
        if score >= warn:
            return Severity.WARNING
        if score >= self.config.sensitivity:
            return Severity.INFO
        return Severity.NONE

    def _no_variance_result(self, value: float, mean: float) -> AnomalyResult:
        is_anomaly = value != mean
        return AnomalyResult(
            value=value,
            is_anomaly=is_anomaly,
            severity=Severity.INFO if is_anomaly else Severity.NONE,
            method=self.config.method.value,
            baseline_mean=mean,
            baseline_std=0.0,
            message='zero variance in baseline' if is_anomaly else 'no variance, value matches baseline',
        )


# ======================================================================
# Pure helper functions
# ======================================================================


def _mean_std(data: Deque[float]) -> tuple[float, float]:
    """Compute mean and population standard deviation."""
    n = len(data)
    if n == 0:
        return 0.0, 0.0
    mean = sum(data) / n
    var = sum((x - mean) ** 2 for x in data) / n
    return mean, math.sqrt(var)


def _percentile(sorted_data: list[float], p: float) -> float:
    """Linear-interpolation percentile on pre-sorted data."""
    n = len(sorted_data)
    if n == 0:
        return 0.0
    k = (p / 100) * (n - 1)
    f = math.floor(k)
    c = math.ceil(k)
    if f == c:
        return sorted_data[int(k)]
    return sorted_data[f] * (c - k) + sorted_data[c] * (k - f)
