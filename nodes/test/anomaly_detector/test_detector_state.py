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

"""The anomaly detector's window as state (plan 5.7, section 12): a stored window continues exactly."""

import json
import random

import pytest

from nodes.anomaly_detector.detector import STATE_VERSION, AnomalyDetector

# ==== Helpers ====================================================================


def _settings(**overrides):
    """A call's settings as the node reads them."""
    settings = {
        'method': 'z_score',
        'sensitivity': 2.0,
        'windowSize': 20,
        'warningThreshold': 2.0,
        'criticalThreshold': 3.0,
        'metric': 'value',
    }
    settings.update(overrides)
    return settings


def _stream(count, seed=7):
    """A noisy stream with a few spikes."""
    rng = random.Random(seed)
    values = [100.0 + rng.gauss(0, 3) for _ in range(count)]
    for index in (9, 23, 41):
        if index < count:
            values[index] = 160.0
    return values


def _through_state(values, settings_of):
    """Score each value with a detector rebuilt from the stored window, as a call does."""
    stored, results = None, []
    for index, value in enumerate(values):
        detector = AnomalyDetector(settings_of(index), stored)
        results.append(detector.detect(value))
        # JSON is what the state store keeps: the blob must survive it exactly
        stored = json.loads(json.dumps(detector.to_state()))
    return results, stored


# ==== One detector vs. one per call ===============================================


@pytest.mark.parametrize('method', ['z_score', 'iqr', 'rolling_avg'])
def test_a_window_rebuilt_from_state_scores_exactly_as_one_detector(method):
    values = _stream(60)
    whole = AnomalyDetector(_settings(method=method))
    expected = [whole.detect(value) for value in values]
    results, _stored = _through_state(values, lambda _i: _settings(method=method))
    assert results == expected


def test_the_method_may_change_between_calls_on_one_window():
    # Every value maintains the z-score aggregates, so a z_score call after IQR
    # calls scores against the whole window, exactly as a z_score-only run would
    values = _stream(50)
    methods = ['iqr' if index % 3 else 'z_score' for index in range(len(values))]
    results, _stored = _through_state(values, lambda i: _settings(method=methods[i]))

    z_only = AnomalyDetector(_settings(method='z_score'))
    iqr_only = AnomalyDetector(_settings(method='iqr'))
    for index, value in enumerate(values):
        z_result, iqr_result = z_only.detect(value), iqr_only.detect(value)
        assert results[index] == (iqr_result if methods[index] == 'iqr' else z_result)


def test_a_smaller_window_keeps_the_newest_values():
    _results, stored = _through_state(_stream(30), lambda _i: _settings(windowSize=20))
    assert len(stored['window']) == 20

    smaller = AnomalyDetector(_settings(windowSize=10), stored)
    assert smaller._get_window_snapshot() == stored['window'][-10:]

    # The trimmed window scores like a detector that only ever saw those values
    fresh = AnomalyDetector(_settings(windowSize=10))
    for value in stored['window'][-10:]:
        fresh.detect(value)
    assert smaller.detect(170.0) == fresh.detect(170.0)


def test_a_larger_window_keeps_everything_and_continues():
    _results, stored = _through_state(_stream(15), lambda _i: _settings(windowSize=20))
    larger = AnomalyDetector(_settings(windowSize=40), stored)
    assert larger._get_window_snapshot() == stored['window']


def test_only_a_call_that_added_a_value_changes_the_window():
    detector = AnomalyDetector(_settings())
    assert detector.changed is False
    detector.detect(float('nan'))
    assert detector.changed is False
    assert detector.evaluate_text('no number here') == 'no number here'
    assert detector.changed is False
    detector.detect(1.0)
    assert detector.changed is True


@pytest.mark.parametrize(
    'blob',
    [
        None,
        {},
        {'version': STATE_VERSION + 1, 'window': [1.0, 2.0]},
        {'version': STATE_VERSION, 'window': 'not a list'},
    ],
)
def test_a_blob_it_cannot_read_starts_the_series_empty(blob):
    assert AnomalyDetector(_settings(), blob)._get_window_snapshot() == []


def test_damaged_aggregates_are_rebuilt_from_the_window():
    _results, stored = _through_state(_stream(12), lambda _i: _settings())
    damaged = dict(stored, sx='garbage', window=stored['window'] + ['x', float('nan')])
    rebuilt = AnomalyDetector(_settings(), damaged)
    assert rebuilt._get_window_snapshot() == stored['window']
    intact = AnomalyDetector(_settings(), stored)
    assert rebuilt.detect(140.0)['severity'] == intact.detect(140.0)['severity']


def test_text_value_finds_the_first_number():
    assert AnomalyDetector.text_value(' 42.5 ') == 42.5
    assert AnomalyDetector.text_value('cpu at 97% on web-1') == 97.0
    assert AnomalyDetector.text_value('no digits') is None
