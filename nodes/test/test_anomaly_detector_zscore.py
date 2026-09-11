"""Equivalence and edge tests for the incremental z_score path (detector.py).

The z_score method maintains mean and variance with O(1) shifted running sums
instead of a two-pass scan over the whole window. These tests pin the observable
output to an independent from-scratch two-pass oracle (exact dict equality, no
epsilon) and exercise the edge cases the incremental bookkeeping has to get
right: eviction, non-finite no-ops, the periodic recompute boundary,
large-magnitude numerical stability, and concurrent access.

Exact 4dp equality is asserted at moderate magnitudes (including a 1e6
cancellation trap that a naive sum_sq/n - mean**2 would fail). At 1e9 magnitude
four decimals are still well within float64 resolution (spacing ~1.2e-7), so
those streams compare mean, std, and z against the oracle within explicit
tolerances rather than a byte-identical details string, which pins the accuracy
while tolerating a last-digit summation-order flip.
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
    """Build a z_score AnomalyDetector with default config plus any overrides."""
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
        """Fewer than two values in the window reports 'insufficient data'."""
        det = _make_detector()
        assert det.detect(5.0)['details'] == 'insufficient data'  # empty window
        assert det.detect(6.0)['details'] == 'insufficient data'  # one value

    def test_golden_window_mean5_std2(self):
        """A hand-checked window [3, 7] scores value 9 as z = 2.0 exactly."""
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
        """Severity flips at the exact warning (z=2.0) and critical (z=3.0) points."""
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
        """A window of identical small values reports exact 'zero variance'."""
        det = _make_detector()
        for _ in range(10):
            det.detect(7.0)
        result = det.detect(7.0)
        assert result['details'] == 'zero variance', result
        assert result['score'] == 0.0
        assert result['is_anomalous'] is False

    def test_all_identical_large_magnitude(self):
        """Identical 1e9 values still yield exact 'zero variance', not float noise."""
        det = _make_detector()
        for _ in range(50):
            det.detect(1e9)
        result = det.detect(1e9)
        assert result['details'] == 'zero variance', result

    def test_zero_variance_after_eviction(self):
        """Once the old spread is evicted, a constant window returns to zero variance."""
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
        """A small window over many evictions matches the oracle at every step."""
        rng = random.Random(1234)
        values = [rng.gauss(100.0, 15.0) for _ in range(60)]
        _assert_equiv(values, windowSize=10)

    def test_moderate_stream_window_100(self):
        """A default-sized window over a long stream matches the oracle at every step."""
        rng = random.Random(5678)
        values = [rng.gauss(500.0, 40.0) for _ in range(600)]
        _assert_equiv(values, windowSize=100)

    def test_stream_with_spikes(self):
        """Periodic large spikes entering and leaving the window stay equivalent."""
        rng = random.Random(99)
        values = []
        for i in range(500):
            base = rng.gauss(100.0, 10.0)
            values.append(base + 500.0 if i % 37 == 0 else base)
        _assert_equiv(values, windowSize=50)

    def test_cancellation_trap_1e6(self):
        """A 1e6 base with tiny spread (where the naive identity loses ~12 digits) stays 4dp-exact."""
        # sum_sq ~ 1e12*n while mean**2 ~ 1e12, so sum_sq/n - mean**2 cancels
        # catastrophically; the shifted sums keep 4dp exact.
        rng = random.Random(4321)
        values = [1e6 + rng.uniform(-3.0, 3.0) for _ in range(400)]
        _assert_equiv(values, windowSize=50)

    def test_negative_and_mixed_sign(self):
        """A stream centered on zero with both signs matches the oracle."""
        rng = random.Random(2718)
        values = [rng.gauss(0.0, 25.0) for _ in range(400)]
        _assert_equiv(values, windowSize=64)

    @pytest.mark.slow
    def test_large_window_10000(self):
        """The maximum window over 3x its size (crossing recomputes) stays 4dp-exact."""
        rng = random.Random(2024)
        values = [rng.gauss(0.0, 1.0) for _ in range(30000)]  # 3x window; crosses recompute
        _assert_equiv(values, windowSize=10000)


class TestLargeMagnitudeStability:
    """1e9-magnitude streams must track the two-pass oracle closely, not merely
    stay finite.

    At ~1e9 the float64 spacing is about 1.2e-7, so four decimals is well within
    resolution and the results are accurate. What makes an exact byte-for-byte
    string match fragile is only that two different summation orders can round
    the last displayed digit differently. So these streams compare the parsed
    mean, std, and z against the oracle within explicit tolerances, which is what
    actually pins the numerical-stability behavior. On the pinned seeds the
    measured discrepancy is tiny: the mean agrees to a relative ~1e-13 and the
    displayed std and z match the oracle exactly (rel 0.0 at 4dp); the tolerances
    below are deliberately looser headroom for a last-digit summation-order flip.
    A naive sum_sq/n - mean**2 would miss by orders of magnitude or return a
    negative variance here, blowing past any of these tolerances.
    """

    def _assert_close(self, values, *, mean_rel, std_rel, z_rel, abs_tol, **cfg):
        """Feed values through the detector and oracle, asserting each numeric
        result agrees within the given tolerances (guard strings must match exactly).
        """
        det = _make_detector(**cfg)
        mirror = deque(maxlen=det.window_size)
        for i, v in enumerate(values):
            expected = _ref_z_score(list(mirror), v, det.warning_threshold, det.critical_threshold)
            got = det.detect(v)
            mirror.append(v)

            exp_p = _parse_z_details(expected['details'])
            got_p = _parse_z_details(got['details'])
            # Guard-string branches (insufficient data / zero variance) must match
            # exactly; only the numeric branch is compared with a tolerance.
            assert (exp_p is None) == (got_p is None), f'step {i}: branch mismatch\n  {expected}\n  {got}'
            if exp_p is None:
                assert got['details'] == expected['details'], f'step {i}: {got} != {expected}'
                continue

            assert math.isfinite(got_p['std']) and got_p['std'] >= 0.0, got
            assert math.isclose(got_p['mean'], exp_p['mean'], rel_tol=mean_rel, abs_tol=abs_tol), (
                f'step {i}: mean {got_p["mean"]} vs oracle {exp_p["mean"]}'
            )
            assert math.isclose(got_p['std'], exp_p['std'], rel_tol=std_rel, abs_tol=abs_tol), (
                f'step {i}: std {got_p["std"]} vs oracle {exp_p["std"]}'
            )
            assert math.isclose(got_p['z'], exp_p['z'], rel_tol=z_rel, abs_tol=abs_tol), (
                f'step {i}: z {got_p["z"]} vs oracle {exp_p["z"]}'
            )
        return det

    def test_large_base_small_spread(self):
        """1e9 +/- small spread: mean/std/z stay within tolerance of the oracle."""
        rng = random.Random(7)
        values = [1e9 + rng.uniform(-5.0, 5.0) for _ in range(400)]
        self._assert_close(values, mean_rel=1e-9, std_rel=1e-3, z_rel=1e-3, abs_tol=2e-4, windowSize=50)

    def test_monotonic_timestamp_like(self):
        """A drifting ~1.7e9 timestamp stream stays within tolerance of the oracle."""
        base = 1_700_000_000.0
        values = [base + i * 0.5 for i in range(400)]
        self._assert_close(values, mean_rel=1e-9, std_rel=1e-3, z_rel=1e-3, abs_tol=2e-4, windowSize=100)


class TestEviction:
    """Once past capacity the window holds exactly the last W values."""

    def test_snapshot_is_last_window_values(self):
        """After 3x window of input, the window is exactly the last W values fed."""
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
        """NaN/inf interleaved with finite data stay no-ops and preserve equivalence."""
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
        """Injecting non-finite values leaves the shifted sums exactly as they were."""
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
        """A stream long enough to trigger ~10 rebuilds matches the oracle throughout."""
        window_size = 10  # recompute fires every 10 values
        rng = random.Random(31337)
        values = [rng.gauss(75.0, 12.0) for _ in range(10 * window_size)]  # ~10 recomputes
        _assert_equiv(values, windowSize=window_size)


class TestConcurrency:
    """Shared detector under many threads stays internally consistent."""

    @pytest.mark.timeout(60)
    def test_concurrent_detect_is_consistent(self):
        """8 threads x 2000 calls on one detector leave aggregates matching a two-pass."""
        window_size = 100
        det = _make_detector(windowSize=window_size)
        errors = []

        def worker(seed):
            """Run 2000 detections with a per-thread seeded stream, recording any failure."""
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

        # The maintained aggregates (never rebuilt here on purpose, so any update
        # lost to a race stays observable) must still match a fresh two-pass over
        # the current window.
        expected = _ref_z_score(snapshot, 123.4, det.warning_threshold, det.critical_threshold)
        got = det.detect(123.4)
        assert got == expected, f'post-concurrency mismatch:\n  expected {expected}\n  got      {got}'
