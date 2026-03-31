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

    def _detect_z_score(self, value: float, window: list) -> Dict[str, Any]:
        """
        Z-Score detection: measures how many standard deviations
        a value is from the mean.
        """
        if len(window) < 2:
            return {'score': 0.0, 'severity': 'normal', 'is_anomalous': False, 'details': 'insufficient data'}

        mean = sum(window) / len(window)
        variance = sum((x - mean) ** 2 for x in window) / len(window)
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
        n = len(sorted_vals)
        q1 = sorted_vals[n // 4]
        q3 = sorted_vals[(3 * n) // 4]
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
        Detect anomalies using rolling (moving) average deviation.

        Computes a local mean from the most recent N values (where N defaults
        to half the window size) and measures how far the new value deviates
        from that local mean, normalized by the full window standard deviation.
        """
        if len(window) < 2:
            return {'score': 0.0, 'severity': 'normal', 'is_anomalous': False, 'details': 'insufficient data'}

        # Use a sliding sub-window for the local (moving) average
        rolling_n = max(2, self.window_size // 2)
        recent = window[-rolling_n:]
        local_mean = sum(recent) / len(recent)

        # Full window std dev for normalization
        full_mean = sum(window) / len(window)
        variance = sum((x - full_mean) ** 2 for x in window) / len(window)
        std_dev = math.sqrt(variance)

        if std_dev == 0:
            return {'score': 0.0, 'severity': 'normal', 'is_anomalous': False, 'details': 'zero variance'}

        deviation = abs(value - local_mean) / std_dev
        severity = self._classify_severity(deviation)

        return {
            'score': round(deviation, 4),
            'severity': severity,
            'is_anomalous': deviation >= self.warning_threshold,
            'details': f'deviation={deviation:.4f} local_mean={local_mean:.4f} rolling_n={len(recent)} std={std_dev:.4f}',
        }

    def detect(self, value: float) -> Dict[str, Any]:
        """
        Run anomaly detection on a single numeric value.

        The value is added to the sliding window, then evaluated against
        the window's statistical properties using the configured method.

        Returns a dict with keys: score, severity, is_anomalous, details.
        """
        window = self._get_window_snapshot()

        if self.method == 'iqr':
            result = self._detect_iqr(value, window)
        elif self.method == 'rolling_avg':
            result = self._detect_rolling_avg(value, window)
        else:
            result = self._detect_z_score(value, window)

        self._add_value(value)
        return result

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
            debug(f'    Anomaly detector: skipping non-numeric text (length={len(text) if isinstance(text, str) else 0})')
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
            return {'score': 0.0, 'severity': 'normal', 'is_anomalous': False, 'details': f'metric "{self.metric}" not found'}

        try:
            value = float(raw_value)
        except (ValueError, TypeError):
            return {'score': 0.0, 'severity': 'normal', 'is_anomalous': False, 'details': f'metric "{self.metric}" is not numeric'}

        return self.detect(value)
