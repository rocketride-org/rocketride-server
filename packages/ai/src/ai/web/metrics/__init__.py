# Include the basic support
import contextvars
from typing import Optional

# Per-pipe billing context.  Set by taskMetricsObjectBegin on the pipe's
# thread, read by ai.common.models to attribute GPU inference time to the
# correct pipe.  Each pipe runs on exactly one thread so this is safe
# without additional synchronisation.
#
# IMPORTANT: This must be defined BEFORE importing submodules (.metrics,
# .taskhook) because they reference current_pipe_id via ``from . import``.
current_pipe_id: contextvars.ContextVar[Optional[int]] = contextvars.ContextVar('current_pipe_id', default=None)

from .metrics import metrics
from .taskhook import taskMetricsBegin, taskMetricsObjectBegin, taskMetricsObjectEnd, taskMetricsEnd

__all__ = [
    'metrics',
    'current_pipe_id',
    'taskMetricsBegin',
    'taskMetricsObjectBegin',
    'taskMetricsObjectEnd',
    'taskMetricsEnd',
]
