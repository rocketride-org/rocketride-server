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
Unit tests for MetricsManager.

Tests cover:
- timer() context manager — timing and accumulation
- add_time() — dict-based timer accumulation
- counter() — counter increment
- event() — structured event recording
- reset() — clearing all accumulators
- report() — snapshot generation
- Thread safety — concurrent access from multiple threads
- Both paths combine — timer() and add_time() accumulate into same key
"""

import threading
import time

import pytest

from ai.web.metrics.metrics import MetricsManager


# ============================================================================
# FIXTURES
# ============================================================================


@pytest.fixture
def m():
    """Create a fresh MetricsManager for each test."""
    return MetricsManager()


# ============================================================================
# TIMER TESTS
# ============================================================================


class TestTimer:
    """Tests for the timer() context manager."""

    def test_timer_basic(self, m):
        """timer() should record positive elapsed milliseconds."""
        with m.timer('gpu'):
            time.sleep(0.01)  # 10ms

        report = m.report()
        assert 'gpu' in report['timers']
        assert report['timers']['gpu'] > 0

    def test_timer_accumulates(self, m):
        """Multiple timer() calls with the same name should accumulate."""
        # First call
        with m.timer('gpu'):
            time.sleep(0.01)

        first = m.report()['timers']['gpu']

        # Second call — should add to the first
        with m.timer('gpu'):
            time.sleep(0.01)

        second = m.report()['timers']['gpu']
        assert second > first

    def test_timer_different_names(self, m):
        """timer() with different names should create separate entries."""
        with m.timer('gpu'):
            time.sleep(0.005)
        with m.timer('preprocess'):
            time.sleep(0.005)

        report = m.report()
        assert 'gpu' in report['timers']
        assert 'preprocess' in report['timers']


# ============================================================================
# ADD_TIME TESTS
# ============================================================================


class TestAddTime:
    """Tests for the add_time() dict-based timer accumulation."""

    def test_add_time_single_key(self, m):
        """add_time() should set a timer value."""
        m.add_time({'gpu': 42.5})

        report = m.report()
        assert report['timers']['gpu'] == 42.5

    def test_add_time_multiple_keys(self, m):
        """add_time() should set multiple timer values in one call."""
        m.add_time(
            {
                'preprocess': 5.0,
                'gpu': 100.0,
                'postprocess': 3.0,
                'queue_wait': 12.0,
                'latency': 120.0,
            }
        )

        report = m.report()
        assert report['timers']['preprocess'] == 5.0
        assert report['timers']['gpu'] == 100.0
        assert report['timers']['postprocess'] == 3.0
        assert report['timers']['queue_wait'] == 12.0
        assert report['timers']['latency'] == 120.0

    def test_add_time_accumulates(self, m):
        """Multiple add_time() calls should accumulate values."""
        m.add_time({'gpu': 50.0})
        m.add_time({'gpu': 30.0})

        report = m.report()
        assert report['timers']['gpu'] == 80.0

    def test_timer_and_add_time_combine(self, m):
        """timer() and add_time() should accumulate into the same key."""
        # Start with add_time
        m.add_time({'gpu': 50.0})

        # Then use timer context manager
        with m.timer('gpu'):
            time.sleep(0.01)

        report = m.report()
        # Should be 50ms + whatever the timer measured (~10ms)
        assert report['timers']['gpu'] > 50.0


# ============================================================================
# COUNTER TESTS
# ============================================================================


class TestCounter:
    """Tests for the counter() method."""

    def test_counter_basic(self, m):
        """counter() should record an integer value."""
        m.counter('gpu_inference_count', 1)

        report = m.report()
        assert report['counters']['gpu_inference_count'] == 1

    def test_counter_accumulates(self, m):
        """Multiple counter() calls should accumulate."""
        m.counter('gpu_inference_count', 1)
        m.counter('gpu_inference_count', 1)
        m.counter('gpu_inference_count', 1)

        report = m.report()
        assert report['counters']['gpu_inference_count'] == 3

    def test_counter_arbitrary_value(self, m):
        """counter() should accept values other than 1."""
        m.counter('pages', 42)

        report = m.report()
        assert report['counters']['pages'] == 42


# ============================================================================
# EVENT TESTS
# ============================================================================


class TestEvent:
    """Tests for the event() method."""

    def test_event_basic(self, m):
        """event() should append a structured dict."""
        m.event({'llamaparse_pages': 10, 'mode': 'precise'})

        report = m.report()
        assert len(report['events']) == 1
        assert report['events'][0]['llamaparse_pages'] == 10

    def test_event_preserves_order(self, m):
        """Multiple events should be recorded in order."""
        m.event({'seq': 1})
        m.event({'seq': 2})
        m.event({'seq': 3})

        report = m.report()
        assert len(report['events']) == 3
        assert [e['seq'] for e in report['events']] == [1, 2, 3]


# ============================================================================
# RESET TESTS
# ============================================================================


class TestReset:
    """Tests for the reset() method."""

    def test_reset_clears_everything(self, m):
        """reset() should clear all timers, counters, and events."""
        # Populate all three collections
        m.add_time({'gpu': 100.0})
        m.counter('gpu_inference_count', 5)
        m.event({'test': True})

        # Verify they're populated
        report = m.report()
        assert len(report['timers']) > 0
        assert len(report['counters']) > 0
        assert len(report['events']) > 0

        # Reset
        m.reset()

        # Verify everything is empty
        report = m.report()
        assert report['timers'] == {}
        assert report['counters'] == {}
        assert report['events'] == []


# ============================================================================
# REPORT TESTS
# ============================================================================


class TestReport:
    """Tests for the report() method."""

    def test_report_returns_snapshot(self, m):
        """report() should return a snapshot independent of future mutations."""
        m.add_time({'gpu': 100.0})
        report1 = m.report()

        # Mutate after snapshot
        m.add_time({'gpu': 50.0})
        report2 = m.report()

        # First snapshot should be unchanged
        assert report1['timers']['gpu'] == 100.0
        assert report2['timers']['gpu'] == 150.0

    def test_report_empty(self, m):
        """report() on a fresh manager should return empty collections."""
        report = m.report()
        assert report == {'timers': {}, 'counters': {}, 'events': []}

    def test_report_shape(self, m):
        """report() should always have timers, counters, and events keys."""
        report = m.report()
        assert 'timers' in report
        assert 'counters' in report
        assert 'events' in report


# ============================================================================
# THREAD SAFETY TESTS
# ============================================================================


class TestThreadSafety:
    """Tests for concurrent access from multiple threads."""

    def test_concurrent_timers(self, m):
        """N threads calling timer('gpu') concurrently should all accumulate."""
        num_threads = 20
        sleep_ms = 10  # Each thread sleeps 10ms
        barrier = threading.Barrier(num_threads)

        def worker():
            """Each worker times a sleep and accumulates into 'gpu'."""
            barrier.wait()  # Synchronize start
            with m.timer('gpu'):
                time.sleep(sleep_ms / 1000)

        # Launch all threads
        threads = [threading.Thread(target=worker) for _ in range(num_threads)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        report = m.report()
        # Each thread added ~10ms, total should be roughly 200ms
        # (they run in parallel so wall-clock is ~10ms, but accumulated is ~200ms)
        assert report['timers']['gpu'] >= num_threads * sleep_ms * 0.5  # Allow some slack

    def test_concurrent_counters(self, m):
        """N threads incrementing the same counter should all be counted."""
        num_threads = 100
        increments_per_thread = 100
        barrier = threading.Barrier(num_threads)

        def worker():
            """Each worker increments the counter many times."""
            barrier.wait()  # Synchronize start
            for _ in range(increments_per_thread):
                m.counter('gpu_inference_count', 1)

        # Launch all threads
        threads = [threading.Thread(target=worker) for _ in range(num_threads)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        report = m.report()
        # Must be exactly num_threads * increments_per_thread — no lost updates
        assert report['counters']['gpu_inference_count'] == num_threads * increments_per_thread

    def test_concurrent_mixed(self, m):
        """Mixed timer + counter + add_time from multiple threads."""
        num_threads = 20
        barrier = threading.Barrier(num_threads)

        def worker():
            """Each worker does a bit of everything."""
            barrier.wait()
            with m.timer('gpu'):
                time.sleep(0.005)
            m.counter('gpu_inference_count', 1)
            m.add_time({'preprocess': 1.0, 'postprocess': 0.5})

        # Launch all threads
        threads = [threading.Thread(target=worker) for _ in range(num_threads)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        report = m.report()
        # All counters should equal num_threads
        assert report['counters']['gpu_inference_count'] == num_threads
        # All add_time values should accumulate correctly
        assert report['timers']['preprocess'] == num_threads * 1.0
        assert report['timers']['postprocess'] == num_threads * 0.5
        # timer('gpu') should have some positive value from all threads
        assert report['timers']['gpu'] > 0
