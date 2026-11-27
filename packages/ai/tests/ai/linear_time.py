# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""A CPU-time check that an operation grows linearly with its input.

No engine imports, so node tests can load it by path as well
(``nodes/test/linear_time.py``).
"""

from __future__ import annotations

from statistics import median
from time import thread_time
from typing import Any, Callable


def assert_linear_time(call: Callable[[Any], Any], small: Any, large: Any) -> None:
    """Fail when ``call(large)`` approaches quadratic CPU growth against ``call(small)``.

    ``large`` is four times the size of ``small``: linear code costs about 4x,
    quadratic code 16x, and the bound is 8x. Thread CPU time leaves out the time a
    busy machine keeps the thread waiting. Calls are batched to span several Windows
    CPU-clock ticks (which can be 15.6 ms), with the same count for both sizes; the
    sizes alternate so a machine that changes speed meets both, and the median of
    three samples drops one outlier. Pytest's suite timeout remains the watchdog
    for code that never returns.
    """

    def measure(arg: Any, repetitions: int) -> float:
        started = thread_time()
        for _ in range(repetitions):
            call(arg)
        return thread_time() - started

    for arg in (small, large):
        measure(arg, 1)
    repetitions = 1
    while measure(small, repetitions) < 0.125:
        repetitions *= 2
    small_samples, large_samples = [], []
    for _ in range(3):
        small_samples.append(measure(small, repetitions))
        large_samples.append(measure(large, repetitions))
    small_time, large_time = median(small_samples), median(large_samples)
    assert large_time < 8 * small_time, (small_time, large_time)
