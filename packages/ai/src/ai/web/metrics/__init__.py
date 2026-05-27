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
Metrics package — public API for pipeline billing and monitoring.

Exports:
    metrics:                 Global MetricsManager singleton (used by wrappers and nodes).
    taskMetricsBegin:        C++ lifecycle hook — called at task start.
    taskMetricsObjectBegin:  C++ lifecycle hook — called at object start (per pipe).
    taskMetricsObjectEnd:    C++ lifecycle hook — called at object end (per pipe).
    taskMetricsEnd:          C++ lifecycle hook — called at task end.
"""

from .metrics import metrics
from .taskhook import taskMetricsBegin, taskMetricsObjectBegin, taskMetricsObjectEnd, taskMetricsEnd

__all__ = [
    'metrics',
    'taskMetricsBegin',
    'taskMetricsObjectBegin',
    'taskMetricsObjectEnd',
    'taskMetricsEnd',
]
