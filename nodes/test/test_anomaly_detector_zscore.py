"""Equivalence and edge tests for the incremental z_score path (detector.py).

The z_score method maintains mean and variance with O(1) shifted running sums
instead of a two-pass scan over the whole window. These tests pin the observable
output to an independent from-scratch two-pass oracle (exact dict equality, no
epsilon) and exercise the edge cases the incremental bookkeeping has to get
right: eviction, non-finite no-ops, the periodic recompute boundary,
large-magnitude numerical stability, and concurrent access.

Exact 4dp equality is asserted at moderate magnitudes (including a 1e6
cancellation trap that a naive sum_sq/n - mean**2 would fail). At 1e9 magnitude,
four decimal places on the mean exceed float64 precision for any algorithm, so
those streams assert the stability invariants (finite, non-negative variance,
exact zero-variance detection) rather than a byte-identical details string.
"""

import math
import os
import random
import re
import sys
import threading
import types
from collections import deque

import pytest

rocketlib = types.ModuleType('rocketlib')
rocketlib.debug = lambda *a, **kw: None
sys.modules.setdefault('rocketlib', rocketlib)

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src', 'nodes', 'anomaly_detector'))
from detector import AnomalyDetector

_NON_FINITE_RESULT = {'score': 0.0, 'severity': 'normal', 'is_anomalous': False, 'details': 'non-finite input'}


def _make_detector(**overrides):
    config = {
        'method': 'z_score',
        'sensitivity': 2.0,
        'windowSize': 100,
        'warningThreshold': 2.0,
        'criticalThreshold': 3.0,
    }
    config.update(overrides)
    return AnomalyDetector(config)


def _ref_z_score(window, value, warn, crit):
    """Independent two-pass reference: population variance, the original guards.

    This is a from-scratch reimplementation of the pre-optimization logic. It is
    deliberately NOT built on the detector's code, so matching it proves the
    incremental path reproduces the original observable output.
    """
    if len(window) < 2:
        return {'score': 0.0, 'severity': 'normal', 'is_anomalous': False, 'details': 'insufficient data'}

    mean = sum(window) / len(window)
    variance = sum((x - mean) ** 2 for x in window) / len(window)
    std_dev = math.sqrt(variance)

    if std_dev == 0:
        return {'score': 0.0, 'severity': 'normal', 'is_anomalous': False, 'details': 'zero variance'}

    z = abs(value - mean) / std_dev
    if z >= crit:
        severity = 'critical'
    elif z >= warn:
        severity = 'warning'
    else:
        severity = 'normal'

    return {
        'score': round(z, 4),
        'severity': severity,
        'is_anomalous': z >= warn,
        'details': f'z_score={z:.4f} mean={mean:.4f} std={std_dev:.4f}',
    }


_DETAIL_RE = re.compile(r'z_score=(?P<z>\S+) mean=(?P<mean>\S+) std=(?P<std>\S+)')


def _parse_z_details(details):
    """Parse a z_score details string into floats for readable failure diffs."""
    m = _DETAIL_RE.match(details)
    if not m:
        return None
    return {k: float(v) for k, v in m.groupdict().items()}


def _assert_equiv(values, warn=2.0, crit=3.0, **cfg):
    """Feed values through the detector and an independent oracle in lockstep.

    Asserts exact result-dict equality at every step. Non-finite values are
    expected to be a complete no-op (no window mutation), mirrored here by not
    advancing the reference window. Returns (detector, mirror_window).
    """
    det = _make_detector(warningThreshold=warn, criticalThreshold=crit, **cfg)
    mirror = deque(maxlen=det.window_size)
    for i, v in enumerate(values):
        if not math.isfinite(v):
            got = det.detect(v)
            assert got == _NON_FINITE_RESULT, f'step {i}: non-finite {v!r} -> {got}'
            continue
        expected = _ref_z_score(list(mirror), v, warn, crit)
        got = det.detect(v)
        mirror.append(v)
        assert got == expected, (
            f'step {i}: value={v!r} window_size={det.window_size}\n'
            f'  expected {expected}\n'
            f'  got      {got}\n'
            f'  parsed expected={_parse_z_details(expected["details"])} '
            f'got={_parse_z_details(got["details"])}'
        )
    return det, mirror


class TestZScoreBaseline:
    """Baseline z_score behavior that had no coverage before this change."""

    def test_insufficient_data_below_two(self):
        det = _make_detector()
        assert det.detect(5.0)['details'] == 'insufficient data'  # empty window
        assert det.detect(6.0)['details'] == 'insufficient data'  # one value

    def test_golden_window_mean5_std2(self):
        # Window [3, 7] -> mean 5, population std 2. Value 9 -> z = |9-5|/2 = 2.0.
        det = _make_detector()
        det.detect(3.0)
        det.detect(7.0)
        result = det.detect(9.0)
        assert result['details'] == 'z_score=2.0000 mean=5.0000 std=2.0000', result
        assert result['score'] == 2.0
        assert result['severity'] == 'warning'
        assert result['is_anomalous'] is True

    def test_severity_boundaries(self):
        # Window [3, 7]: mean 5, std 2. z = 1.95 (normal), 2.0 (warning), 3.0 (critical).
        for value, expected in [(8.9, 'normal'), (9.0, 'warning'), (11.0, 'critical')]:
            det = _make_detector()
            det.detect(3.0)
            det.detect(7.0)
            result = det.detect(value)
            assert result['severity'] == expected, f'value={value}: {result}'


class TestZeroVariance:
    """All-identical windows must report exact 'zero variance', not float noise.

    This is the primary cancellation regression guard: a naive
    sum_sq/n - mean**2 identity produces a tiny non-zero (or negative) variance
    for large-magnitude identical values, which would leak a bogus z-score.
    """

    def test_all_identical_small(self):
        det = _make_detector()
        for _ in range(10):
            det.detect(7.0)
        result = det.detect(7.0)
        assert result['details'] == 'zero variance', result
        assert result['score'] == 0.0
        assert result['is_anomalous'] is False

    def test_all_identical_large_magnitude(self):
        det = _make_detector()
        for _ in range(50):
            det.detect(1e9)
        result = det.detect(1e9)
        assert result['details'] == 'zero variance', result

    def test_zero_variance_after_eviction(self):
        # Fill with varied data, then flood with a constant until the window is
        # entirely that constant. Eviction of the old spread must leave variance
        # at exactly zero.
        det = _make_detector(windowSize=10)
        for v in [1.0, 2.0, 3.0, 99.0, 5.0]:
            det.detect(v)
        for _ in range(15):
            det.detect(42.0)
        result = det.detect(42.0)
        assert result['details'] == 'zero variance', result


class TestEquivalence:
    """Exact dict equality vs the two-pass oracle across many evictions."""

    def test_moderate_stream_window_10(self):
        rng = random.Random(1234)
        values = [rng.gauss(100.0, 15.0) for _ in range(60)]
        _assert_equiv(values, windowSize=10)

    def test_moderate_stream_window_100(self):
        rng = random.Random(5678)
        values = [rng.gauss(500.0, 40.0) for _ in range(600)]
        _assert_equiv(values, windowSize=100)

    def test_stream_with_spikes(self):
        rng = random.Random(99)
        values = []
        for i in range(500):
            base = rng.gauss(100.0, 10.0)
            values.append(base + 500.0 if i % 37 == 0 else base)
        _assert_equiv(values, windowSize=50)

    def test_cancellation_trap_1e6(self):
        # Large base with a small spread: sum_sq ~ 1e12*n while mean**2 ~ 1e12,
        # so the naive identity loses ~12 digits. The shifted sums keep 4dp exact.
        rng = random.Random(4321)
        values = [1e6 + rng.uniform(-3.0, 3.0) for _ in range(400)]
        _assert_equiv(values, windowSize=50)

    def test_negative_and_mixed_sign(self):
        rng = random.Random(2718)
        values = [rng.gauss(0.0, 25.0) for _ in range(400)]
        _assert_equiv(values, windowSize=64)

    @pytest.mark.slow
    def test_large_window_10000(self):
        rng = random.Random(2024)
        values = [rng.gauss(0.0, 1.0) for _ in range(30000)]  # 3x window; crosses recompute
        _assert_equiv(values, windowSize=10000)


class TestLargeMagnitudeStability:
    """1e9-magnitude streams: assert the numeric invariants, not a 4dp string.

    Four decimals on a ~1e9 mean is below float64 resolution for any method, so
    exact string equality is not a meaningful contract here. What must hold is
    that variance never goes negative and sqrt never raises.
    """

    def _assert_sane(self, values, **cfg):
        det = _make_detector(**cfg)
        for v in values:
            result = det.detect(v)
            parsed = _parse_z_details(result['details'])
            if parsed is not None:
                assert math.isfinite(parsed['std']), result
                assert parsed['std'] >= 0.0, result
                assert math.isfinite(parsed['z']), result
        return det

    def test_large_base_small_spread(self):
        rng = random.Random(7)
        values = [1e9 + rng.uniform(-5.0, 5.0) for _ in range(400)]
        self._assert_sane(values, windowSize=50)

    def test_monotonic_timestamp_like(self):
        base = 1_700_000_000.0
        values = [base + i * 0.5 for i in range(400)]
        self._assert_sane(values, windowSize=100)


class TestEviction:
    """Once past capacity the window holds exactly the last W values."""

    def test_snapshot_is_last_window_values(self):
        window_size = 20
        rng = random.Random(555)
        values = [rng.gauss(50.0, 5.0) for _ in range(3 * window_size)]
        det, mirror = _assert_equiv(values, windowSize=window_size)

        snapshot = det._get_window_snapshot()
        assert len(snapshot) == window_size, f'expected full window, got {len(snapshot)}'
        assert snapshot == values[-window_size:], 'window is not the last W values fed'
        assert snapshot == list(mirror)


class TestNonFinite:
    """Interleaved NaN/inf must be a complete no-op and never corrupt aggregates."""

    def test_interleaved_non_finite_equivalence(self):
        rng = random.Random(808)
        values = []
        for i in range(300):
            if i % 11 == 0:
                values.append(float('nan'))
            elif i % 17 == 0:
                values.append(float('inf'))
            elif i % 23 == 0:
                values.append(float('-inf'))
            else:
                values.append(rng.gauss(200.0, 30.0))
        det, mirror = _assert_equiv(values, windowSize=40)

        # The window must contain only the finite values that were fed.
        assert det._get_window_snapshot() == list(mirror)

    def test_non_finite_does_not_shift_aggregates(self):
        # Two detectors with identical finite history; inject non-finite values
        # into one only. A subsequent identical value must score the same, which
        # can only hold if the non-finite inputs left the window and the shifted
        # sums completely untouched.
        clean = _make_detector(windowSize=10)
        dirty = _make_detector(windowSize=10)
        for v in [10.0, 12.0, 11.0, 13.0, 12.0]:
            clean.detect(v)
            dirty.detect(v)
        dirty.detect(float('nan'))
        dirty.detect(float('inf'))
        dirty.detect(float('-inf'))
        assert clean.detect(9.0) == dirty.detect(9.0)
        assert clean._get_window_snapshot() == dirty._get_window_snapshot()


class TestRecomputeBoundary:
    """Crossing several recompute checkpoints must not introduce a discontinuity."""

    def test_crosses_multiple_recomputes(self):
        window_size = 10  # recompute fires every 10 values
        rng = random.Random(31337)
        values = [rng.gauss(75.0, 12.0) for _ in range(10 * window_size)]  # ~10 recomputes
        _assert_equiv(values, windowSize=window_size)


class TestConcurrency:
    """Shared detector under many threads stays internally consistent."""

    @pytest.mark.timeout(60)
    def test_concurrent_detect_is_consistent(self):
        window_size = 100
        det = _make_detector(windowSize=window_size)
        errors = []

        def worker(seed):
            rng = random.Random(seed)
            try:
                for _ in range(2000):
                    result = det.detect(rng.gauss(100.0, 20.0))
                    parsed = _parse_z_details(result['details'])
                    if parsed is not None:
                        assert parsed['std'] >= 0.0
            except Exception as exc:  # noqa: BLE001 — surface any thread failure to the test
                errors.append(exc)

        threads = [threading.Thread(target=worker, args=(s,)) for s in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert not errors, f'worker(s) raised: {errors}'
        snapshot = det._get_window_snapshot()
        assert len(snapshot) <= window_size

        # After the concurrent churn the aggregates must still agree with a
        # two-pass over the current window. Force a rebuild so the check is
        # exact rather than dependent on where the recompute counter landed.
        with det._lock:
            det._recompute_z_aggregates()
        expected = _ref_z_score(snapshot, 123.4, det.warning_threshold, det.critical_threshold)
        got = det.detect(123.4)
        assert got == expected, f'post-concurrency mismatch:\n  expected {expected}\n  got      {got}'
