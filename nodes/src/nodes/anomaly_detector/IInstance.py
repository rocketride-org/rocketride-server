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
Anomaly detector node instance.

Extracts a numeric metric from each pipeline output, feeds it to the
shared ``AnomalyDetector``, and annotates the output text with anomaly
metadata when an anomaly is detected.
"""

from __future__ import annotations

import json
import time
from typing import Any

from rocketlib import IInstanceBase, warning

from .detector import AnomalyResult
from .IGlobal import IGlobal

# Metric extraction strategies keyed by config name.
_METRIC_EXTRACTORS: dict[str, Any] = {
    'response_length': lambda text: float(len(text)),
    'token_count': lambda text: float(len(text.split())),
    'latency': None,  # handled separately via timing
    'sentiment_score': None,  # requires upstream metadata
}


class IInstance(IInstanceBase):
    """Per-thread instance for the anomaly detector filter."""

    IGlobal: IGlobal

    _metric: str = 'response_length'
    _start_time: float = 0.0

    def beginInstance(self) -> None:
        cfg = self.instance.connConfig if hasattr(self.instance, 'connConfig') else {}
        self._metric = str(cfg.get('metric') or 'response_length').strip()

    def endInstance(self) -> None:
        pass

    # ------------------------------------------------------------------
    # Filter interface — text lane
    # ------------------------------------------------------------------

    def writeTextBegin(self) -> None:
        self._text_parts: list[str] = []
        self._start_time = time.monotonic()

    def writeText(self, text: str) -> None:
        self._text_parts.append(text)

    def writeTextEnd(self) -> str:
        """Evaluate the accumulated text and return annotated output."""
        full_text = ''.join(self._text_parts)
        detector = getattr(self.IGlobal, 'detector', None)

        if detector is None:
            warning('anomaly_detector: detector not initialized, passing through')
            return full_text

        value = self._extract_metric(full_text)
        if value is None:
            return full_text

        result: AnomalyResult = detector.observe(value)

        if result.is_anomaly:
            annotation = _build_annotation(result, self._metric)
            return f'{full_text}\n\n<!-- ANOMALY {annotation} -->'

        return full_text

    # ------------------------------------------------------------------
    # Metric extraction
    # ------------------------------------------------------------------

    def _extract_metric(self, text: str) -> float | None:
        """Return a numeric value for the configured metric."""
        if self._metric == 'latency':
            return time.monotonic() - self._start_time

        if self._metric == 'sentiment_score':
            return _try_parse_sentiment(text)

        extractor = _METRIC_EXTRACTORS.get(self._metric)
        if extractor is None:
            warning(f'anomaly_detector: unknown metric {self._metric!r}')
            return None

        try:
            return extractor(text)
        except Exception:
            return None


# ======================================================================
# Helpers
# ======================================================================


def _build_annotation(result: AnomalyResult, metric: str) -> str:
    """Build a compact JSON annotation string."""
    payload = {
        'metric': metric,
        'value': round(result.value, 4),
        'severity': result.severity.value,
        'score': round(result.score, 4),
        'method': result.method,
        'baseline_mean': round(result.baseline_mean, 4),
        'baseline_std': round(result.baseline_std, 4),
        'message': result.message,
    }
    return json.dumps(payload, separators=(',', ':'))


def _try_parse_sentiment(text: str) -> float | None:
    """Attempt to extract a sentiment_score from structured output.

    Looks for a ``"sentiment_score": <number>`` pattern in the text,
    which would be present if an upstream LLM node emits JSON.
    """
    try:
        data = json.loads(text)
        if isinstance(data, dict) and 'sentiment_score' in data:
            return float(data['sentiment_score'])
    except (json.JSONDecodeError, TypeError, ValueError):
        pass

    # Fallback: scan for the key as a substring (handles partial JSON).
    import re

    match = re.search(r'"sentiment_score"\s*:\s*([-+]?\d*\.?\d+)', text)
    if match:
        return float(match.group(1))
    return None
