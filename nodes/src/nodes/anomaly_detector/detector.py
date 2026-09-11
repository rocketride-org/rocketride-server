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

"""
Anomaly detection engine using statistical methods.

Supports Z-Score, IQR (Interquartile Range), and Rolling Average deviation
detection with a thread-safe sliding window for streaming pipeline data.
"""

import math
import re
import threading
from collections import deque
from typing import Any, Dict

from rocketlib import debug


class AnomalyDetector:
    """
    Statistical anomaly detector with a thread-safe sliding window.

    Maintains a fixed-size window of recent values and evaluates new
    data points against statistical thresholds to classify severity.
    """

    def __init__(self, config: Dict[str, Any]):
        """Initialize the anomaly detector with the given configuration."""
        self.method = config.get('method', 'z_score')
        self.sensitivity = config.get('sensitivity', 2.0)
        self.window_size = config.get('windowSize', 100)
        self.metric = config.get('metric', 'value')
        self.warning_threshold = config.get('warningThreshold', 2.0)
        self.critical_threshold = config.get('criticalThreshold', 3.0)

        self._window: deque = deque(maxlen=self.window_size)
        self._lock = threading.Lock()

        # Incremental z-score aggregates, maintained under self._lock.
        # Assumed-mean shifted running sums over the current window:
        #   _z_sx  = sum(x - _z_k)      _z_sxx = sum((x - _z_k) ** 2)
        # These are updated in O(1) as values are appended/evicted and are
        # rebuilt from scratch every _z_recompute_interval values to bound
        # floating point drift and re-center the shift constant _z_k. See
        # _update_z_aggregates / _recompute_z_aggregates / _format_z_score.
        self._z_k = 0.0
        self._z_sx = 0.0
        self._z_sxx = 0.0
        self._z_since_recompute = 0
        self._z_recompute_interval = (
            self.window_size if isinstance(self.window_size, int) and self.window_size >= 1 else 1
        )

    def _add_value(self, value: float) -> None:
        """Add a value to the sliding window (thread-safe)."""
        with self._lock:
            self._window.append(value)

    def _get_window_snapshot(self) -> list:
        """Return a snapshot of the current window (thread-safe)."""
        with self._lock:
            return list(self._window)

    def _classify_severity(self, score: float) -> str:
        """Classify anomaly severity based on score and thresholds."""
        if score >= self.critical_threshold:
            return 'critical'
        elif score >= self.warning_threshold:
            return 'warning'
        return 'normal'

    def _update_z_aggregates(self, value: float, n: int) -> None:
        """
        Append ``value`` to the window and update the z-score running sums.

        The caller must hold ``self._lock``. ``n`` is ``len(window)`` captured
        before the append. Maintains the shifted sums in O(1); every
        ``_z_recompute_interval`` values it rebuilds them from scratch
        (amortized O(1)) to bound rounding drift and re-center the shift
        constant.
        """
        maxlen = self._window.maxlen
        at_capacity = maxlen is not None and n > 0 and n == maxlen
        # deque(maxlen) drops the oldest element on append without returning
        # it, so capture the value about to be evicted first.
        evicted = self._window[0] if at_capacity else 0.0

        self._window.append(value)

        if n == 0:
            # First value in an (effectively) empty window: anchor the shift
            # constant here so the shifted sums start at exactly zero.
            self._z_k = value
            self._z_sx = 0.0
            self._z_sxx = 0.0
        else:
            d = value - self._z_k
            self._z_sx += d
            self._z_sxx += d * d
            if at_capacity:
                de = evicted - self._z_k
                self._z_sx -= de
                self._z_sxx -= de * de

        self._z_since_recompute += 1
        if self._z_since_recompute >= self._z_recompute_interval:
            self._recompute_z_aggregates()
            self._z_since_recompute = 0

    def _recompute_z_aggregates(self) -> None:
        """
        Rebuild the shifted running sums from the current window contents.

        Runs in O(W) and is called once every ``_z_recompute_interval``
        updates, so the amortized per-value cost stays O(1). Re-centering the
        shift constant on the current mean keeps the summed quantities small
        (limiting floating point cancellation) even when the stream drifts,
        and clears any rounding residue left by the incremental updates. The
        caller must hold ``self._lock``.
        """
        n = len(self._window)
        if n == 0:
            self._z_k = 0.0
            self._z_sx = 0.0
            self._z_sxx = 0.0
            return

        k = sum(self._window) / n
        sx = 0.0
        sxx = 0.0
        for x in self._window:
            d = x - k
            sx += d
            sxx += d * d
        self._z_k = k
        self._z_sx = sx
        self._z_sxx = sxx

    def _format_z_score(self, value: float, n: int, k: float, sx: float, sxx: float) -> Dict[str, Any]:
        """
        Build the z-score result dict from the window aggregates.

        Reproduces the original two-pass computation exactly: population
        variance, the ``len < 2`` and zero-variance guards, and identical
        rounding / formatting. Pure function of its arguments with no access
        to shared state, so it runs outside the lock.
        """
        if n < 2:
            return {'score': 0.0, 'severity': 'normal', 'is_anomalous': False, 'details': 'insufficient data'}

        mean = k + sx / n
        # Variance via the shifted sums. The tiny negative residue that
        # rounding can produce on a zero/near-zero-variance window is clamped
        # so sqrt never sees a negative argument.
        variance = sxx / n - (sx / n) ** 2
        if variance < 0.0:
            variance = 0.0
        std_dev = math.sqrt(variance)

        if std_dev == 0:
            return {'score': 0.0, 'severity': 'normal', 'is_anomalous': False, 'details': 'zero variance'}

        z_score = abs(value - mean) / std_dev
        severity = self._classify_severity(z_score)

        return {
            'score': round(z_score, 4),
            'severity': severity,
            'is_anomalous': z_score >= self.warning_threshold,
            'details': f'z_score={z_score:.4f} mean={mean:.4f} std={std_dev:.4f}',
        }

    def _detect_iqr(self, value: float, window: list) -> Dict[str, Any]:
        """
        IQR detection: uses the interquartile range to identify outliers.
        Values beyond Q1 - sensitivity*IQR or Q3 + sensitivity*IQR are anomalous.
        """
        if len(window) < 4:
            return {'score': 0.0, 'severity': 'normal', 'is_anomalous': False, 'details': 'insufficient data'}

        sorted_vals = sorted(window)

        # Linear interpolation for quartiles
        def percentile(data: list, p: float) -> float:
            k = (len(data) - 1) * p
            f = math.floor(k)
            c = math.ceil(k)
            if f == c:
                return data[f]
            return data[f] * (c - k) + data[c] * (k - f)

        q1 = percentile(sorted_vals, 0.25)
        q3 = percentile(sorted_vals, 0.75)
        iqr = q3 - q1

        if iqr == 0:
            return {'score': 0.0, 'severity': 'normal', 'is_anomalous': False, 'details': 'zero IQR'}

        lower_bound = q1 - self.sensitivity * iqr
        upper_bound = q3 + self.sensitivity * iqr

        if value < lower_bound:
            distance = (lower_bound - value) / iqr
        elif value > upper_bound:
            distance = (value - upper_bound) / iqr
        else:
            distance = 0.0

        severity = self._classify_severity(distance)

        return {
            'score': round(distance, 4),
            'severity': severity,
            'is_anomalous': distance > 0,
            'details': f'iqr_distance={distance:.4f} Q1={q1:.4f} Q3={q3:.4f} IQR={iqr:.4f}',
        }

    def _detect_rolling_avg(self, value: float, window: list) -> Dict[str, Any]:
        """
        Detect anomalies using rolling (moving) average percentage deviation.

        Computes a simple moving average from the most recent N values (where
        N defaults to half the window size) and measures how far the new value
        deviates from that local mean as a percentage. The percentage is divided
        by (sensitivity * 10) to produce a normalized score compared against
        warning_threshold / critical_threshold to classify severity.

        Unlike Z-Score, this method does NOT normalize by standard deviation.
        It uses relative percentage deviation, making it more intuitive for
        business metrics where a "10% deviation" has a clear meaning.
        """
        if len(window) < 2:
            return {'score': 0.0, 'severity': 'normal', 'is_anomalous': False, 'details': 'insufficient data'}

        # Use a sliding sub-window for the local (moving) average
        rolling_n = max(2, len(window) // 2)
        recent = window[-rolling_n:]
        local_mean = sum(recent) / len(recent)

        if local_mean == 0:
            return {'score': 0.0, 'severity': 'normal', 'is_anomalous': False, 'details': 'zero mean'}

        # Percentage deviation from the rolling mean
        pct_deviation = abs(value - local_mean) / abs(local_mean) * 100.0

        # Effective threshold formula: pct = sensitivity * 10 * threshold.
        # With defaults (sensitivity=2.0, warning_threshold=2.0, critical_threshold=3.0),
        # warning fires at pct_deviation >= 40%, critical at >= 60%.
        score = pct_deviation / (self.sensitivity * 10.0) if self.sensitivity > 0 else 0.0
        severity = self._classify_severity(score)
        warning_pct = self.sensitivity * 10.0 * self.warning_threshold
        critical_pct = self.sensitivity * 10.0 * self.critical_threshold

        return {
            'score': round(score, 4),
            'severity': severity,
            'is_anomalous': score >= self.warning_threshold,
            'details': f'pct_deviation={pct_deviation:.2f}% local_mean={local_mean:.4f} rolling_n={len(recent)} warning_at={warning_pct:.2f}% critical_at={critical_pct:.2f}%',
        }

    def detect(self, value: float) -> Dict[str, Any]:
        """
        Run anomaly detection on a single numeric value.

        The value is evaluated against the window as it stood before this
        value, then added. The read of the window state and the append happen
        under a single lock so another thread cannot insert between them; the
        scoring arithmetic itself runs outside the lock.

        Returns a dict with keys: score, severity, is_anomalous, details.
        """
        if not math.isfinite(value):
            return {'score': 0.0, 'severity': 'normal', 'is_anomalous': False, 'details': 'non-finite input'}

        # IQR and rolling_avg keep the original snapshot-and-scan path: they
        # need the full window contents (sorted / most-recent slice).
        if self.method == 'iqr' or self.method == 'rolling_avg':
            with self._lock:
                window = list(self._window)
                self._window.append(value)
            if self.method == 'iqr':
                return self._detect_iqr(value, window)
            return self._detect_rolling_avg(value, window)

        # z_score (and any unrecognized method, preserving the original
        # fallback) is maintained incrementally. The result is a function of
        # the window as it stood before this value, so capture the aggregates
        # under the lock, then release it before the O(1) formatting work.
        with self._lock:
            n = len(self._window)
            k, sx, sxx = self._z_k, self._z_sx, self._z_sxx
            self._update_z_aggregates(value, n)

        return self._format_z_score(value, n, k, sx, sxx)

    _NUMERIC_PATTERN = re.compile(r'-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?')

    def evaluate_text(self, text: str) -> str:
        """
        Evaluate text for anomalous numeric values.

        First tries to parse the entire text as a float. If that fails,
        extracts the first numeric value via regex. If no number can be
        found, logs a debug message and passes the text through unchanged.
        """
        value = None
        try:
            value = float(text.strip())
        except (ValueError, AttributeError):
            match = self._NUMERIC_PATTERN.search(text if isinstance(text, str) else '')
            if match:
                value = float(match.group())

        if value is None:
            debug(
                f'    Anomaly detector: skipping non-numeric text (length={len(text) if isinstance(text, str) else 0})'
            )
            return text

        result = self.detect(value)
        if result['is_anomalous']:
            return f'{text} [ANOMALY: {result["severity"]} score={result["score"]}]'
        return text

    def evaluate_document(self, metadata: Dict[str, Any]) -> Dict[str, Any]:
        """
        Evaluate a document's metric field for anomalies.

        Reads the configured metric field from metadata and runs detection.
        Returns the detection result dict.
        """
        raw_value = metadata.get(self.metric)
        if raw_value is None:
            return {
                'score': 0.0,
                'severity': 'normal',
                'is_anomalous': False,
                'details': f'metric "{self.metric}" not found',
            }

        try:
            value = float(raw_value)
        except (ValueError, TypeError):
            return {
                'score': 0.0,
                'severity': 'normal',
                'is_anomalous': False,
                'details': f'metric "{self.metric}" is not numeric',
            }

        return self.detect(value)
