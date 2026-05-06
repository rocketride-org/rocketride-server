# MIT License
#
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

"""
Pipeline billing hooks called by C++ rocketlib at well-defined lifecycle points.

Each pipe runs on exactly one thread.  ``taskMetricsObjectBegin`` sets a
``ContextVar`` so that downstream code (e.g. ``ai.common.models``) can
attribute GPU inference time to the correct pipe without an explicit
``pipe_id`` parameter.

On object end and task end the accumulated metrics are emitted to stdout
via the ``>MET*`` protocol so the parent process (``TaskMetrics``) can
ingest them for billing.
"""

import json
import sys

from rocketlib import Entry

from . import current_pipe_id
from .metrics import metrics


def taskMetricsBegin(taskId: str):
    """
    Signal beginning of a task in a pipeline.

    Initializes a new metrics context and starts the total
    timer.  Called on the main thread by C++ rocketlib.
    """
    metrics.begin_task(taskId)


def taskMetricsObjectBegin(taskId: str, pipe_id: int, obj: Entry):
    """
    Signal beginning of an object in a pipeline.

    Sets the per-thread ``current_pipe_id`` ContextVar so that model
    wrappers can attribute GPU time to this pipe.  Initializes pipe-level
    timers and counters (including an auto-starting ``cpu`` timer).
    Called on the pipe's instance thread by C++ rocketlib.
    """
    current_pipe_id.set(pipe_id)
    metrics.begin_object(taskId, pipe_id)


def taskMetricsObjectEnd(taskId: str, pipe_id: int, obj: Entry):
    """
    Signal end of an object in a pipeline.

    Stops all pipe timers, merges pipe metrics into the task totals,
    emits a ``>MET*`` billing snapshot to stdout, and clears the
    ``current_pipe_id`` ContextVar.
    Called on the pipe's instance thread by C++ rocketlib.
    """
    # Stop timers and merge pipe metrics into task totals
    metrics.end_object(taskId, pipe_id)

    # Emit billing snapshot to parent process via stdout protocol
    report = metrics.report_for_billing(taskId)
    if report:
        print(f'>MET*{json.dumps(report)}', file=sys.stdout, flush=True)

    # Clear the billing context for this thread
    current_pipe_id.set(None)


def taskMetricsEnd(taskId: str):
    """
    Signal end of a task in a pipeline.

    Emits a final billing snapshot and tears down the task metrics
    context.  Called on the main thread by C++ rocketlib.
    """
    # Emit final billing snapshot before tearing down
    report = metrics.report_for_billing(taskId)
    if report:
        print(f'>MET*{json.dumps(report)}', file=sys.stdout, flush=True)

    metrics.end_task(taskId)
