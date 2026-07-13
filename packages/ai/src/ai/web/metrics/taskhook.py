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
Pipeline billing hooks called by C++ rocketlib at well-defined lifecycle points.

These four functions are invoked by the C++ engine at task/object boundaries.
Their signatures must not change (they are part of the C++/Python contract).

Two stdio protocols carry subprocess metrics to the parent:

- ``>MET*`` — live point-in-time metrics for the dashboard (cpu_percent,
  cpu_memory_mb, gpu_memory_mb).  Emitted every ~1 second by ProcessReporter.
- ``>USG*`` — cumulative billing values for token calculation.  Emitted at
  each object boundary and at task end.

Lifecycle::

    taskMetricsBegin(taskId)                           # start ProcessReporter
        taskMetricsObjectBegin(taskId, pipe_id, obj)   # count request
        ... node processes the object ...
        taskMetricsObjectEnd(taskId, pipe_id, obj)     # emit >USG* snapshot
    taskMetricsEnd(taskId)                             # stop ProcessReporter, final >USG*
"""

import json

from rocketlib import Entry, monitorOther

from .metrics import metrics
from .process_reporter import process_reporter


# ============================================================================
# TASK LIFECYCLE HOOKS
# ============================================================================


def taskMetricsBegin(taskId: str):
    """
    Signal beginning of a task in a pipeline.

    Resets all metric accumulators and starts the ProcessReporter thread
    so the new task starts with a clean slate.  Called on the main thread
    by C++ rocketlib.

    Args:
        taskId: Unique identifier for the task.
    """
    # Clear any leftover state from a previous task
    metrics.reset()

    # Start live metrics reporting (>MET* every ~1s)
    process_reporter.start()


def taskMetricsObjectBegin(taskId: str, pipe_id: int, obj: Entry):
    """
    Signal beginning of an object in a pipeline.

    Increments the ``requests`` counter to track total objects processed.
    Called on the pipe's instance thread by C++ rocketlib.

    Args:
        taskId: Task identifier.
        pipe_id: Pipe instance identifier.
        obj: The rocketlib Entry being processed.
    """
    # Count each object entering the pipeline
    metrics.counter('requests', 1)


def taskMetricsObjectEnd(taskId: str, pipe_id: int, obj: Entry):
    """
    Signal end of an object in a pipeline.

    Emits a cumulative ``>USG*`` billing snapshot so the parent process
    can update token charges.  Called on the pipe's instance thread by
    C++ rocketlib.

    Args:
        taskId: Task identifier.
        pipe_id: Pipe instance identifier.
        obj: The rocketlib Entry that was processed.
    """
    # Build a cumulative snapshot of all billing values
    report = metrics.report()

    # Emit to parent process via the >USG* stdout protocol
    if report:
        monitorOther('USG', json.dumps(report, separators=(',', ':')))


def taskMetricsEnd(taskId: str):
    """
    Signal end of a task in a pipeline.

    Stops the ProcessReporter (which does a final sample to ensure
    billing accumulators are up to date), then emits a final ``>USG*``
    snapshot.  Called on the main thread by C++ rocketlib.

    Args:
        taskId: Task identifier.
    """
    # Stop live reporting and do final sample
    process_reporter.stop()

    # Emit final billing snapshot
    report = metrics.report()
    if report:
        monitorOther('USG', json.dumps(report, separators=(',', ':')))
