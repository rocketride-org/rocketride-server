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
# The above copyright notice and this permission notice shall be included in all
# copies or substantial portions of the Software.
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
Unit tests for ProcessReporter's periodic ``>USG*`` billing emission.

``>USG*`` is otherwise emitted only at pipeline object boundaries (taskhook).
ProcessReporter additionally emits a cumulative ``>USG*`` snapshot on the
billing cadence so an idle pipeline (e.g. a chat holding models with no
traffic) is still billed for the GPU/RAM it reserves. These tests stub the OS
resource reads and rocketlib so ``_sample()`` is platform-independent, then
assert the interval gate around the emission.
"""

from __future__ import annotations

import sys
import time
import types
from unittest.mock import MagicMock

import pytest

from ai.web.metrics import process_reporter as pr_mod
from ai.web.metrics.process_reporter import ProcessReporter


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def fake_rocketlib(monkeypatch):
    """Install a fake ``rocketlib`` exposing monitorMetrics / monitorOther."""
    mod = types.ModuleType('rocketlib')
    mod.monitorMetrics = MagicMock()
    mod.monitorOther = MagicMock()
    monkeypatch.setitem(sys.modules, 'rocketlib', mod)
    return mod


@pytest.fixture(autouse=True)
def fake_platform_reads(monkeypatch):
    """Stub the OS resource reads so ``_sample()`` runs on any platform."""
    # _sample() mutates the shared metrics singleton (cpu_compute/cpu_memory);
    # reset it around each test so values don't leak between tests.
    pr_mod.metrics.reset()
    monkeypatch.setattr(pr_mod, '_read_cpu_times', lambda: (0.0, 0.0))
    monkeypatch.setattr(pr_mod, '_read_rss_mb', lambda: 100.0)
    monkeypatch.setattr(pr_mod, '_read_gpu_vram_mb', lambda: 0.0)
    yield
    pr_mod.metrics.reset()


def _usg_calls(fake_rocketlib) -> list:
    """Return the monitorOther calls tagged 'USG'."""
    return [c for c in fake_rocketlib.monitorOther.call_args_list if c.args and c.args[0] == 'USG']


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_sample_emits_periodic_usg_after_interval(fake_rocketlib):
    """Once the billing interval has elapsed, _sample() emits a >USG* snapshot."""
    reporter = ProcessReporter(interval=1.0)
    reporter._usg_interval = 10.0
    reporter._last_wall = 0.0
    # Force the USG clock far into the past so the interval gate opens.
    reporter._last_usg_wall = -1000.0

    reporter._sample()

    assert _usg_calls(fake_rocketlib), 'expected a >USG* emission once the interval elapsed'
    # The live >MET* snapshot is always emitted regardless of the USG cadence.
    assert fake_rocketlib.monitorMetrics.called


def test_sample_skips_usg_within_interval(fake_rocketlib):
    """No >USG* is emitted before the billing interval elapses (idempotent samples)."""
    reporter = ProcessReporter(interval=1.0)
    reporter._usg_interval = 10_000.0  # effectively never within a single test
    reporter._last_wall = 0.0
    # Pretend a >USG* was just emitted.
    reporter._last_usg_wall = time.monotonic()

    reporter._sample()

    assert not _usg_calls(fake_rocketlib), 'should not emit >USG* within the interval'
    # Live metrics still flow every sample.
    assert fake_rocketlib.monitorMetrics.called
