"""
Process-wide admission guard for in-process inference, one per device.

Without ``--modelserver`` every call of a guarded model enters through the guard of its
device with an estimate of the memory it needs. On a GPU a call enters when it fits in
what the device can still give: driver free memory, plus this process's torch cache not
in use, minus what the calls already inside may still claim, minus a margin. The first
call always enters, so an image too large for the card still runs alone. Calls enter in
arrival order, so a large one is not overtaken forever by small ones. Waiters re-check
when a call leaves and every ``RECHECK_S`` seconds, which sees memory freed by the
desktop or another process. Other devices (CPU) admit up to ``CPU_SLOTS`` calls.

With ``--modelserver`` inference runs in the server, which has its own dispatcher, and
the guard is a no-op.
"""

import collections
import contextlib
import threading
from typing import Callable, Dict, Iterator, List, Optional, Tuple

from .base import is_model_server_enabled

# Calls inside one GPU at once, whatever memory is left
MAX_CONCURRENT = 4

# Calls inside one CPU (or another non-CUDA device) at once; EasyOCR on CPU scales almost
# linearly up to 4 and needs about 1 GB of RAM per call
CPU_SLOTS = 4

# Memory left for the desktop and for estimate errors
MARGIN_MB = 512

# How often a waiter re-reads the device when nothing leaves
RECHECK_S = 0.5

_MB = float(1 << 20)

# (driver free MB, own torch cache not in use MB, own torch allocated MB)
Probe = Callable[[], Tuple[float, float, float]]


def _cuda_probe(device: str) -> Probe:
    from ai.common.torch import torch

    index = int(device.split(':')[1])

    def probe() -> Tuple[float, float, float]:
        free, _ = torch.cuda.mem_get_info(index)
        reserved = torch.cuda.memory_reserved(index)
        allocated = torch.cuda.memory_allocated(index)
        return free / _MB, (reserved - allocated) / _MB, allocated / _MB

    return probe


class DeviceBudget:
    """Admission guard of one device; see the module docstring."""

    def __init__(self, device: str, probe: Optional[Probe] = None):
        """Guard ``device`` ('cuda:N' or another device name); ``probe`` reads the device's memory."""
        self.device = device
        self._gpu = device.startswith('cuda')
        self._probe = probe if probe or not self._gpu else _cuda_probe(device)
        self._cond = threading.Condition()
        self._queue: collections.deque = collections.deque()
        self._inside: List[Optional[float]] = []
        self._idle_allocated = 0.0

    @contextlib.contextmanager
    def reserve(self, cost_mb: Optional[float]) -> Iterator[None]:
        """Run the block as one call costing ``cost_mb``; ``None`` = alone on the device (cost not known)."""
        ticket = object()
        with self._cond:
            self._queue.append(ticket)
            try:
                while not (self._queue[0] is ticket and self._admits(cost_mb)):
                    self._cond.wait(RECHECK_S)
            finally:
                self._queue.remove(ticket)
                self._cond.notify_all()
            self._inside.append(cost_mb)
        try:
            yield
        finally:
            with self._cond:
                self._inside.remove(cost_mb)
                self._cond.notify_all()

    def _admits(self, cost_mb: Optional[float]) -> bool:
        if not self._inside:
            if self._gpu:
                self._idle_allocated = self._probe()[2]
            return True
        if cost_mb is None or None in self._inside:
            return False
        if not self._gpu:
            return len(self._inside) < CPU_SLOTS
        if len(self._inside) >= MAX_CONCURRENT:
            return False
        free, cache_free, allocated = self._probe()
        # what the calls inside may still claim: their costs less what they already hold
        claimed = max(0.0, sum(self._inside) - (allocated - self._idle_allocated))
        return cost_mb <= free + cache_free - claimed - MARGIN_MB


class _NoBudget:
    def reserve(self, cost_mb: Optional[float]) -> contextlib.AbstractContextManager:
        return contextlib.nullcontext()


_NO_BUDGET = _NoBudget()
_budgets: Dict[str, DeviceBudget] = {}
_budgets_lock = threading.Lock()


def device_budget(device: str):
    """Return the process-wide guard of ``device`` ('cpu', 'cuda' or 'cuda:N'); a no-op with ``--modelserver``."""
    if is_model_server_enabled():
        return _NO_BUDGET
    device = str(device)
    if device == 'cuda':
        device = 'cuda:0'
    with _budgets_lock:
        budget = _budgets.get(device)
        if budget is None:
            budget = _budgets[device] = DeviceBudget(device)
        return budget
