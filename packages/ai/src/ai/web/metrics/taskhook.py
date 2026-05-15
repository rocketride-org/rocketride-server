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

Lifecycle::

    taskMetricsBegin(taskId)                       # once per task
        taskMetricsObjectBegin(taskId, pipe_id, obj)   # once per object per pipe
        ... node processes the object ...
        taskMetricsObjectEnd(taskId, pipe_id, obj)     # emits >MET* snapshot
    taskMetricsEnd(taskId)                         # emits final >MET* snapshot

The ``>MET*`` protocol emits cumulative metric snapshots to stdout via
``rocketlib.monitorMetrics``.  The parent process (``TaskMetrics``) replaces
its previous snapshot on each report — values are running totals.
"""

from rocketlib import Entry, monitorMetrics

from .metrics import metrics


# ============================================================================
# TASK LIFECYCLE HOOKS
# ============================================================================


def taskMetricsBegin(taskId: str):
    """
    Signal beginning of a task in a pipeline.

    Resets all metric accumulators so the new task starts with a clean
    slate.  Called on the main thread by C++ rocketlib.

    Args:
        taskId: Unique identifier for the task.
    """
    # Clear any leftover state from a previous task
    metrics.reset()


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

    Emits a cumulative ``>MET*`` billing snapshot via ``monitorMetrics``
    so the parent process can track progress.  Called on the pipe's
    instance thread by C++ rocketlib.

    Args:
        taskId: Task identifier.
        pipe_id: Pipe instance identifier.
        obj: The rocketlib Entry that was processed.
    """
    # Build a cumulative snapshot of all metrics collected so far
    report = metrics.report()

    # Emit to parent process via the >MET* stdout protocol
    if report:
        monitorMetrics(report)


def taskMetricsEnd(taskId: str):
    """
    Signal end of a task in a pipeline.

    Emits a final ``>MET*`` billing snapshot capturing any metrics
    accumulated after the last object-end report.  Called on the
    main thread by C++ rocketlib.

    Args:
        taskId: Task identifier.
    """
    # Emit final snapshot — captures any trailing metrics
    report = metrics.report()
    if report:
        monitorMetrics(report)
