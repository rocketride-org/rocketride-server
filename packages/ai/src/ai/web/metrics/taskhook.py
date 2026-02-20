from rocketlib import Entry
# from .metrics import metrics

"""
The task metrics are stored be the metrics modules and managed by that module
"""


def taskMetricsBegin(taskId: str):
    """
    Signal beginning of a task in a pipeline.

    Initializes a new metrics context and starts the total
    timer. This is called on the main thread so the metrics
    are stored in the main thread context.
    """
    # metrics.begin_task(taskId)
    return


def taskMetricsObjectBegin(taskId: str, pipe_id: int, obj: Entry):
    """
    Signal beginning of an object in a pipeline.

    Initializes a new metrics context and starts the total
    timer. This is called on the instance thread so the metrics
    are stored in the instance thread context.
    """
    # metrics.begin_object(taskId, pipe_id)
    return


def taskMetricsObjectEnd(taskId: str, pipe_id: int, obj: Entry):
    """
    Signal end of an object in a pipeline.

    Stops timers and prints out collected metrics from the
    context. This is called on the instance thread so the metrics
    are stored in the instance thread context.
    """
    # Get the metrics report - this will stop all the timers for this thread
    # metrics.end_object(taskId, pipe_id)
    return


def taskMetricsEnd(taskId: str):
    """
    Signal end of a task in a pipeline.

    Stops timers and prints out collected metrics from the
    context. This is called on the main thread so the metrics
    are stored in the main thread context.
    """
    # metrics.end_task(taskId)
    return
