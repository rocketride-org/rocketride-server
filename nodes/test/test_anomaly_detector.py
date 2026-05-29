"""Regression tests for the anomaly_detector node (detector.py).

Covers:
  - rolling_avg classification boundaries (normal / warning / critical)
  - NaN and inf inputs do not mutate the window
  - Early-warmup rolling_n uses len(window)//2, not window_size//2
"""

import os
import sys
import types

rocketlib = types.ModuleType('rocketlib')
rocketlib.debug = lambda *a, **kw: None
sys.modules.setdefault('rocketlib', rocketlib)

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src', 'nodes', 'anomaly_detector'))
from detector import AnomalyDetector


def _make_detector(**overrides):
    config = {
        'method': 'rolling_avg',
        'sensitivity': 2.0,
        'windowSize': 100,
        'warningThreshold': 2.0,
        'criticalThreshold': 3.0,
    }
    config.update(overrides)
    return AnomalyDetector(config)


def _seed(detector, base_value, count):
    """Seed the window with `count` copies of `base_value`."""
    for _ in range(count):
        detector.detect(base_value)


class TestRollingAvgBoundaries:
    """
    With sensitivity=2.0, warning_threshold=2.0, critical_threshold=3.0:
      score = pct_deviation / (sensitivity * 10) = pct_deviation / 20
      warning  when score >= 2.0  →  pct_deviation >= 40%
      critical when score >= 3.0  →  pct_deviation >= 60%
    """

    def setup_method(self):
        self.detector = _make_detector()
        # Seed 20 equal values so local_mean is stable at 100.0
        _seed(self.detector, 100.0, 20)

    def test_39_pct_deviation_is_normal(self):
        """A value at +39% deviation must classify as 'normal'."""
        result = self.detector.detect(139.0)
        assert result['severity'] == 'normal', f"Expected 'normal', got {result['severity']} (score={result['score']})"
        assert result['is_anomalous'] is False

    def test_40_pct_deviation_is_warning_boundary(self):
        """A value at exactly +40% deviation must classify as 'warning' (boundary)."""
        result = self.detector.detect(140.0)
        assert result['severity'] == 'warning', (
            f"Expected 'warning', got {result['severity']} (score={result['score']})"
        )
        assert result['is_anomalous'] is True

    def test_60_pct_deviation_is_critical(self):
        """A value at +60% deviation must classify as 'critical'."""
        result = self.detector.detect(160.0)
        assert result['severity'] == 'critical', (
            f"Expected 'critical', got {result['severity']} (score={result['score']})"
        )
        assert result['is_anomalous'] is True


class TestNonFiniteInputs:
    """NaN and inf must not mutate the internal window."""

    def setup_method(self):
        self.detector = _make_detector()
        _seed(self.detector, 50.0, 5)

    def _snapshot(self):
        return self.detector._get_window_snapshot()

    def test_nan_returns_not_anomalous(self):
        result = self.detector.detect(float('nan'))
        assert result['is_anomalous'] is False

    def test_nan_does_not_mutate_window(self):
        before = self._snapshot()
        self.detector.detect(float('nan'))
        after = self._snapshot()
        assert before == after, f'Window mutated by NaN: {before} -> {after}'

    def test_pos_inf_returns_not_anomalous(self):
        result = self.detector.detect(float('inf'))
        assert result['is_anomalous'] is False

    def test_pos_inf_does_not_mutate_window(self):
        before = self._snapshot()
        self.detector.detect(float('inf'))
        after = self._snapshot()
        assert before == after, f'Window mutated by +inf: {before} -> {after}'

    def test_neg_inf_returns_not_anomalous(self):
        result = self.detector.detect(float('-inf'))
        assert result['is_anomalous'] is False

    def test_neg_inf_does_not_mutate_window(self):
        before = self._snapshot()
        self.detector.detect(float('-inf'))
        after = self._snapshot()
        assert before == after, f'Window mutated by -inf: {before} -> {after}'


class TestEarlyWarmupRollingN:
    """
    With only 4 values in the window, rolling_n must be max(2, 4//2) = 2,
    NOT window_size//2 = 50.  The 'details' field must report rolling_n=2
    and recent must be exactly the last 2 values.
    """

    def test_rolling_n_uses_window_length_not_window_size(self):
        detector = _make_detector(windowSize=100)

        # Seed exactly 4 values
        for v in [10.0, 20.0, 30.0, 40.0]:
            detector.detect(v)

        # The 5th call: window has 4 items, rolling_n = max(2, 4//2) = 2
        result = detector.detect(50.0)

        details = result['details']
        # Extract rolling_n from the details string
        rolling_n_str = [p for p in details.split() if p.startswith('rolling_n=')]
        assert rolling_n_str, f"'rolling_n=' not found in details: {details}"
        rolling_n_reported = int(rolling_n_str[0].split('=')[1])

        assert rolling_n_reported == 2, (
            f'Expected rolling_n=2 (len(window)//2 with 4-item window), '
            f'got rolling_n={rolling_n_reported}. '
            f'If rolling_n=50, the implementation used window_size//2 instead of len(window)//2.'
        )

    def test_rolling_n_recent_values_are_last_two(self):
        """Verify the local mean is computed from the last 2 values, not last 50."""
        detector = _make_detector(windowSize=100)

        # Seed exactly 4 values; last 2 are [30.0, 40.0] → local_mean = 35.0
        for v in [10.0, 20.0, 30.0, 40.0]:
            detector.detect(v)

        # With rolling_n=2, local_mean = (30+40)/2 = 35.0
        # pct_deviation of 70.0 from 35.0 = 100% → score = 100/20 = 5.0 → critical
        result = detector.detect(70.0)
        assert result['severity'] == 'critical', (
            f"Expected 'critical' (rolling from last 2 values, mean=35), "
            f'got {result["severity"]} (score={result["score"]}, details={result["details"]})'
        )
