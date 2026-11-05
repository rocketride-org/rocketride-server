"""
Process-wide admission guard for in-process inference, one per device.

Without ``--modelserver`` every call of a guarded model enters through the guard of its
device with an estimate of the memory it needs. On a GPU a call enters when it fits in
what the device can still give: driver free memory, plus this process's torch cache not
in use, minus what the calls already inside may still claim, minus a margin. The first
call always enters, so an image too large for the card still runs alone. Calls enter in
arrival order, so a large one is not overtaken forever by small ones. Waiters re-check
when a call leaves and every ``RECHECK_S`` seconds, which sees memory freed by the
desktop or another process. What the calls inside already hold is measured from the
allocation seen when the device was last idle, so a lasting allocation made meanwhile
(a lazily loaded model, cuBLAS workspaces) counts as their progress until it drains
again. Other devices (CPU) admit up to ``CPU_SLOTS`` calls.

Another engine process on the same GPU reads the same free memory, so two budgets would
over-commit the card. While NVML lists one there (or a process it cannot name), calls run
one at a time, as with the old lock; for ``SHARED_WAIT_S`` after a neighbour appears, a
lone call also waits until its cost fits, while the calls the neighbour admitted alone
drain. Only processes named like this one, or not named, count: the desktop, browsers
and other servers are ignored.

Torch keeps the memory a call frees cached for this process; the driver, and so another
process, sees it as used. The guard hands that cache back once the device has been idle
for ``IDLE_RELEASE_S``, and before each call while a neighbour is listed, so neither an
idle process nor one that ran several calls alone holds memory the other one needs.

With ``--modelserver`` inference runs in the server, which has its own dispatcher, and
the guard is a no-op.
"""

import collections
import contextlib
import logging
import os
import threading
import time
from typing import Any, Callable, Dict, Iterator, List, Optional, Set, Tuple

from ai.common.utils.hardware import _process_name
from .base import is_model_server_enabled

logger = logging.getLogger('rocketlib.models.device_budget')

# Calls inside one GPU at once, whatever memory is left
MAX_CONCURRENT = 4

# Calls inside one CPU (or another non-CUDA device) at once
CPU_SLOTS = 1

# Memory left for the desktop and for estimate errors
MARGIN_MB = 512

# How often a waiter re-reads the device when nothing leaves
RECHECK_S = 0.5

# How long the list of processes on a GPU is reused
NEIGHBOURS_TTL_S = 1.0

# After a neighbour appears, how long a lone call waits for its cost to fit
SHARED_WAIT_S = 30.0

# How long the device stays idle before this process hands its torch cache back
IDLE_RELEASE_S = 2.0

_MB = float(1 << 20)

# (driver free MB, own torch cache not in use MB, own torch allocated MB)
Probe = Callable[[], Tuple[float, float, float]]

# Whether another engine process may hold the device
Neighbours = Callable[[], bool]

# Hands this process's unused torch cache on the device back to the driver
Release = Callable[[], None]


def _cuda_probe(device: str) -> Probe:
    from ai.common.torch import torch

    index = int(device.split(':')[1])

    def probe() -> Tuple[float, float, float]:
        free, _ = torch.cuda.mem_get_info(index)
        reserved = torch.cuda.memory_reserved(index)
        allocated = torch.cuda.memory_allocated(index)
        return free / _MB, (reserved - allocated) / _MB, allocated / _MB

    return probe


def _cuda_release(device: str) -> Release:
    index = int(device.split(':')[1])

    def release() -> None:
        from ai.common.torch import torch

        with torch.cuda.device(index):
            torch.cuda.empty_cache()

    return release


def _has_neighbour(pids: Set[int], own_pid: int, own_name: str, name_of: Callable[[int], str]) -> bool:
    """Whether ``pids`` (the processes NVML lists on a GPU) hold another process named like ours, or one not named."""
    unnamed = 0
    for pid in pids - {own_pid}:
        name = name_of(pid)
        if name == '?':
            unnamed += 1
        elif name.lower() == own_name:
            return True
    # in another PID namespace NVML lists host pids, and one of the unnamed ones is this process
    if own_pid not in pids and unnamed:
        unnamed -= 1
    return unnamed > 0


def _nvml_neighbours(device: str) -> Neighbours:
    index = int(device.split(':')[1])
    nvml: Dict[str, Any] = {}

    def neighbours() -> bool:
        try:
            import psutil
            import pynvml

            if 'handle' not in nvml:
                from ai.common.torch import torch

                name = psutil.Process().name().lower()
                pynvml.nvmlInit()
                nvml['name'] = name
                nvml['handle'] = pynvml.nvmlDeviceGetHandleByUUID(f'GPU-{torch.cuda.get_device_properties(index).uuid}')
            pids = set()
            for listing in (pynvml.nvmlDeviceGetComputeRunningProcesses, pynvml.nvmlDeviceGetGraphicsRunningProcesses):
                pids.update(proc.pid for proc in listing(nvml['handle']))
            return _has_neighbour(pids, os.getpid(), nvml['name'], _process_name)
        except Exception as e:
            # no NVML, or a device it cannot resolve (e.g. a MIG slice): assume a neighbour
            if not nvml.get('warned'):
                nvml['warned'] = True
                logger.warning('%s: cannot list GPU processes (%s); calls run one at a time', device, e)
            return True

    return neighbours


class DeviceBudget:
    """Admission guard of one device; see the module docstring."""

    def __init__(
        self,
        device: str,
        probe: Optional[Probe] = None,
        neighbours: Optional[Neighbours] = None,
        release: Optional[Release] = None,
    ):
        """Guard ``device`` ('cuda:N' or another device); ``probe`` reads its memory, ``neighbours`` its other engines, ``release`` frees its cache."""
        self.device = device
        self._gpu = device.startswith('cuda')
        self._probe = probe if probe or not self._gpu else _cuda_probe(device)
        self._neighbours = neighbours if neighbours or not self._gpu else _nvml_neighbours(device)
        self._release = release if release or not self._gpu else _cuda_release(device)
        self._cond = threading.Condition()
        self._queue: collections.deque = collections.deque()
        self._inside: List[Optional[float]] = []
        self._idle_allocated = 0.0
        self._shared = False
        self._shared_since = 0.0
        self._neighbours_read = -float('inf')
        self._drains = 0
        self._release_warned = False

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
                if self._gpu and not self._inside and not self._queue:
                    self._release_when_idle()
                self._cond.notify_all()

    def _release_when_idle(self) -> None:
        # calls that come back to back keep the cache; re-allocating it costs each of them
        self._drains += 1
        timer = threading.Timer(IDLE_RELEASE_S, self._release_if_still_idle, args=(self._drains,))
        timer.daemon = True
        timer.start()

    def _release_if_still_idle(self, drain: int) -> None:
        with self._cond:
            if drain == self._drains and not self._inside and not self._queue:
                self._free_cache()

    def _free_cache(self) -> None:
        try:
            self._release()
        except Exception as e:
            # the call itself succeeded; a broken device shows on the next one
            if not self._release_warned:
                self._release_warned = True
                logger.warning('%s: cannot release the torch cache (%s)', self.device, e)

    def _sharing(self) -> bool:
        now = time.monotonic()
        if now - self._neighbours_read >= NEIGHBOURS_TTL_S:
            self._neighbours_read = now
            shared = self._neighbours()
            if shared and not self._shared:
                self._shared_since = now
            self._shared = shared
        return self._shared

    def _admits(self, cost_mb: Optional[float]) -> bool:
        if not self._gpu:
            if not self._inside:
                return True
            if cost_mb is None or None in self._inside:
                return False
            return len(self._inside) < CPU_SLOTS
        shared = self._sharing()
        if not self._inside:
            if shared:
                self._free_cache()
            free, cache_free, self._idle_allocated = self._probe()
            if shared and cost_mb is not None and time.monotonic() - self._shared_since < SHARED_WAIT_S:
                # the neighbour may still be draining the calls it admitted alone
                return cost_mb <= free + cache_free - MARGIN_MB
            return True
        if cost_mb is None or None in self._inside or shared:
            return False
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
