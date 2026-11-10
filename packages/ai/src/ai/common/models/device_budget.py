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
over-commit the card. While NVML lists one there (or a process it cannot name) and has
seen it busy on the GPU in the last ``BUSY_WINDOW_S``, calls run one at a time, as with the
old lock; for ``SHARED_WAIT_S`` after a neighbour appears, a lone call also waits until its
cost fits, while the calls the neighbour admitted alone drain. Only processes named like
this one, or not named, count: the desktop, browsers and other servers are ignored. A
process that only holds a CUDA context (the idle process of a finished task, alive for its
idle TTL) does not count, since it takes no compute; its memory is still used, which the
free-memory reads see. A process that has just started may show start-up samples and count
for about the same window. A neighbour that pauses for longer than the window stops
counting and counts again when it resumes, as a new neighbour does. The guard reads NVML
only when a call arrives, so after an idle gap of its own a neighbour it saw before is not
new to it: the next call enters without that wait, beside what the neighbour, which did
not count this idle process, may have admitted meanwhile. Where NVML cannot
report per-process utilisation, every listed process counts, and so it does until the
samples have once shown this process busy: a driver that samples no engine process would
make every neighbour look idle. In another PID namespace NVML lists host pids, so this
process does not find itself in the samples, and an unnamed process cannot be told from
this one either.

Torch keeps the memory a call frees cached for this process; the driver, and so another
process, sees it as used. The guard hands that cache back once the device has been idle
for ``IDLE_RELEASE_S``, and before each call while a neighbour counts, so neither an
idle process nor one that ran several calls alone holds memory the other one needs.
``torch.cuda.empty_cache()`` takes no device: a release hands back the process's unused
cache on every device, which other models of the process then allocate again. A cached
block goes back only when nothing in it is in use, and the cuBLAS workspace a thread gets
with its first matrix product lives as long as the process (a finished thread's handle
and workspace go to a later thread); allocated inside a large cached block, it would keep
the whole block. So the guard creates that workspace, when a thread first enters on a GPU,
in a memory pool of its own, one thread at a time, and an idle process keeps its models
and one workspace per thread: 8 MiB + 128 KiB, two to a 20 MiB segment (32 MiB on sm_90).
cuBLAS keys a workspace by handle and stream, so the set-up covers the stream current
when the thread first enters (the default one for the OCR models); a thread that ran a
matrix product before it first entered, or later computes on another stream, gets that
workspace where it was, and the 1 MiB cuBLASLt workspace still comes with a thread's
first product, in a 2 MiB segment of small blocks. While a thread sets up, other
allocations on that device skip torch's last retry on out-of-memory (free the whole
cache), ``empty_cache()`` leaves that device's cache, and a block another thread marks
with ``record_stream`` and frees meanwhile loses that stream's use (torch takes it for a
graph capture), so it could be reused early. This lasts one handle creation per thread;
the OCR models record no streams.

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

# How recently NVML must have seen a neighbour busy on the GPU for it to count
BUSY_WINDOW_S = 10.0

# After a neighbour appears, how long a lone call waits for its cost to fit
SHARED_WAIT_S = 30.0

# How long the device stays idle before this process hands its torch cache back
IDLE_RELEASE_S = 2.0

_MB = float(1 << 20)

# (driver free MB, own torch cache not in use MB, own torch allocated MB)
Probe = Callable[[], Tuple[float, float, float]]

# Whether another engine process busy on the device may hold it
Neighbours = Callable[[], bool]

# Hands this process's unused torch cache, on every device, back to the driver
Release = Callable[[], None]

# Creates the calling thread's cuBLAS workspace on the device in a pool of its own
Warm = Callable[[], None]


def _cuda_probe(device: str) -> Probe:
    """Read the memory of a CUDA device as the guard needs it.

    Args:
        device: The device, ``'cuda:N'``.

    Returns:
        A probe returning (driver free MB, this process's unused torch cache MB, its torch allocated MB).
    """
    from ai.common.torch import torch

    index = int(device.split(':')[1])

    def probe() -> Tuple[float, float, float]:
        """Return (driver free MB, own unused torch cache MB, own torch allocated MB) of the device."""
        free, _ = torch.cuda.mem_get_info(index)
        reserved = torch.cuda.memory_reserved(index)
        allocated = torch.cuda.memory_allocated(index)
        return free / _MB, (reserved - allocated) / _MB, allocated / _MB

    return probe


def _cuda_release() -> Release:
    """Hand this process's unused torch cache back to the driver.

    Returns:
        A callable that runs ``torch.cuda.empty_cache()``, which takes no device: the unused
        cache of every device goes back.
    """

    def release() -> None:
        """Run ``torch.cuda.empty_cache()``; memory in use stays."""
        from ai.common.torch import torch

        torch.cuda.empty_cache()

    return release


def _cuda_warm(device: str) -> Warm:
    """Create a thread's cuBLAS workspace on a CUDA device in a memory pool of its own.

    Args:
        device: The device, ``'cuda:N'``.

    Returns:
        A callable that, run in a thread, makes cuBLAS allocate that thread's workspace on the
        device from the pool, where it cannot keep a large cached block from going back.
    """
    index = int(device.split(':')[1])
    pool: Dict[str, Any] = {}
    lock = threading.Lock()

    def warm() -> None:
        """Allocate the calling thread's cuBLAS workspace on the device from the pool."""
        from ai.common.torch import torch

        # one thread at a time: the allocator refuses a second recorder on a pool, from any thread
        with lock, torch.cuda.device(index):
            if 'pool' not in pool:
                # a pool belongs to the device current when it is made
                pool['pool'] = torch.cuda.MemPool()
            with torch.cuda.use_mem_pool(pool['pool']):
                # the first handle request of a thread allocates its workspace; a later one reuses it
                torch.cuda.current_blas_handle()

    return warm


def _busy_pids(pynvml: Any, handle: Any, window_s: float) -> Set[int]:
    """Find the processes NVML saw busy on a GPU in the last ``window_s`` seconds.

    Args:
        pynvml: The NVML binding.
        handle: The NVML handle of the device.
        window_s: How far back to look.

    Returns:
        The pids with a utilisation sample above zero; empty when NVML has no sample at all
        (nothing ran).

    Raises:
        Exception: Any other NVML error, a missing call included, when it cannot report
            per-process utilisation.
    """
    try:
        samples = pynvml.nvmlDeviceGetProcessUtilization(handle, int((time.time() - window_s) * 1e6))
    except Exception as e:
        # NVML answers "not found" when no process had a sample in the window
        not_found = getattr(pynvml, 'NVML_ERROR_NOT_FOUND', None)
        if not_found is not None and getattr(e, 'value', None) == not_found:
            return set()
        raise
    return {s.pid for s in samples if s.smUtil > 0 or s.memUtil > 0}


def _has_neighbour(
    pids: Set[int],
    own_pid: int,
    own_name: str,
    name_of: Callable[[int], str],
    busy: Optional[Set[int]] = None,
) -> bool:
    """Whether the processes NVML lists on a GPU include another engine process.

    Args:
        pids: The process ids NVML lists on the device.
        own_pid: This process's id.
        own_name: This process's executable name, lower case.
        name_of: Names a process id; ``'?'`` when it cannot.
        busy: The pids NVML saw busy recently; ``None`` when it cannot tell, and then every
            listed process counts.

    Returns:
        True if another process is named like this one or cannot be named, and is in ``busy``.
        In another PID namespace, where NVML lists host pids, one unnamed process is taken to
        be this one and the other unnamed ones count whether busy or not.
    """
    foreign = own_pid not in pids
    unnamed = 0
    for pid in pids - {own_pid}:
        name = name_of(pid)
        if name != '?' and name.lower() != own_name:
            continue
        if name == '?' and foreign:
            # a host pid: it cannot be told from this process, so utilisation proves nothing
            unnamed += 1
        elif busy is not None and pid not in busy:
            continue
        elif name == '?':
            unnamed += 1
        else:
            return True
    if foreign and unnamed:
        unnamed -= 1
    return unnamed > 0


def _nvml_neighbours(device: str) -> Neighbours:
    """Find other engine processes on a CUDA device through NVML.

    Args:
        device: The device, ``'cuda:N'``.

    Returns:
        A callable telling whether another engine process busy on the device may hold it; True
        when NVML cannot be read. Without per-process utilisation, and until its samples have
        once shown this process busy, any listed process counts.
    """
    index = int(device.split(':')[1])
    nvml: Dict[str, Any] = {}

    def busy_now(pynvml: Any) -> Optional[Set[int]]:
        """Return the pids NVML saw busy on the device lately, or ``None`` when its samples prove nothing.

        Args:
            pynvml: The NVML binding, initialised, with the device handle in ``nvml``.

        Returns:
            The busy pids; ``None`` without per-process utilisation (logged once) or until the
            samples have once shown this process busy.
        """
        try:
            busy = _busy_pids(pynvml, nvml['handle'], BUSY_WINDOW_S)
        except Exception as e:
            if not nvml.get('util_warned'):
                nvml['util_warned'] = True
                logger.warning(
                    '%s: cannot read GPU process utilisation (%s); every engine process on it counts', device, e
                )
            return None
        # a driver that samples no engine process would make every neighbour idle
        nvml['seen_self'] = nvml.get('seen_self') or os.getpid() in busy
        return busy if nvml['seen_self'] else None

    def neighbours() -> bool:
        """Tell whether another engine process busy on the device may hold it.

        Returns:
            True if NVML lists one that counts (see ``_has_neighbour``), or cannot be read.
        """
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
            return _has_neighbour(pids, os.getpid(), nvml['name'], _process_name, busy_now(pynvml))
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
        warm: Optional[Warm] = None,
    ):
        """Guard one device.

        Args:
            device: ``'cuda:N'``, or another device such as ``'cpu'``.
            probe: Reads the device's memory; the CUDA probe by default on a GPU.
            neighbours: Tells whether another engine process busy on the device may hold it; NVML by default on a GPU.
            release: Hands this process's unused cache back; ``torch.cuda.empty_cache`` by default on a GPU.
            warm: Creates the calling thread's cuBLAS workspace in a pool of its own; by default on a GPU.
        """
        self.device = device
        self._gpu = device.startswith('cuda')
        self._probe = probe if probe or not self._gpu else _cuda_probe(device)
        self._neighbours = neighbours if neighbours or not self._gpu else _nvml_neighbours(device)
        self._release = release if release or not self._gpu else _cuda_release()
        self._warm = warm if warm or not self._gpu else _cuda_warm(device)
        self._cond = threading.Condition()
        self._queue: collections.deque = collections.deque()
        self._inside: List[Optional[float]] = []
        self._idle_allocated = 0.0
        self._shared = False
        self._shared_since = 0.0
        self._neighbours_read = -float('inf')
        self._drained_at = 0.0
        self._release_due = False
        self._releaser: Optional[threading.Thread] = None
        self._release_warned = False
        self._warmed = threading.local()
        self._warm_failed = False
        self._warm_warned = False

    @contextlib.contextmanager
    def reserve(self, cost_mb: Optional[float]) -> Iterator[None]:
        """Run the block as one call on the device, once the guard admits it.

        Args:
            cost_mb: The memory the call needs in MB; ``None`` (not known) runs it alone on the device.

        Yields:
            None, while the call holds its place.
        """
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
            # a call ends the idle spell; only the next drain starts another
            self._release_due = False
        try:
            if self._gpu:
                self._warm_thread()
            yield
        finally:
            with self._cond:
                self._inside.remove(cost_mb)
                if self._gpu and not self._inside and not self._queue:
                    self._release_when_idle()
                self._cond.notify_all()

    def _warm_thread(self) -> None:
        """Create the calling thread's cuBLAS workspace once per thread; a failure is logged once, never raised."""
        # a flag of the thread, not its id: the OS hands a finished thread's id to a new one
        if self._warm_failed or getattr(self._warmed, 'done', False):
            return
        self._warmed.done = True
        try:
            self._warm()
        except Exception as e:
            # the workspace then comes with the first matrix product, as without the guard
            if isinstance(e, AttributeError):
                # a torch without memory pools; another failure (out of memory) stays with its thread
                self._warm_failed = True
            if not self._warm_warned:
                self._warm_warned = True
                logger.warning('%s: cannot set up the cuBLAS workspace in its own pool (%s)', self.device, e)

    def _release_when_idle(self) -> None:
        """Release the cache once the device has stayed idle for ``IDLE_RELEASE_S``; the caller holds the lock."""
        self._drained_at = time.monotonic()
        self._release_due = True
        if self._releaser is None:
            # one thread per guard, started on the first drain; reserve wakes it on every change
            self._releaser = threading.Thread(
                target=self._release_loop, name=f'device-budget-{self.device}', daemon=True
            )
            self._releaser.start()

    def _release_loop(self) -> None:
        """Release the cache each time the device has stayed idle for ``IDLE_RELEASE_S`` after a drain."""
        with self._cond:
            while True:
                self._release_or_wait()

    def _release_or_wait(self) -> None:
        """Release the cache if the idle spell is over, else wait for it to end or for a call; the caller holds the lock."""
        if not self._release_due or self._inside:
            self._cond.wait()
            return
        # calls that come back to back keep the cache; re-allocating it costs each of them
        left = self._drained_at + IDLE_RELEASE_S - time.monotonic()
        if left > 0:
            self._cond.wait(left)
            return
        self._release_due = False
        self._free_cache()

    def _free_cache(self) -> None:
        """Hand the unused cache back to the driver; a failure is logged once, never raised."""
        try:
            self._release()
        except Exception as e:
            # the call itself succeeded; a broken device shows on the next one
            if not self._release_warned:
                self._release_warned = True
                logger.warning('%s: cannot release the torch cache (%s)', self.device, e)

    def _sharing(self) -> bool:
        """Whether another engine process busy on the device may hold it, asked at most every ``NEIGHBOURS_TTL_S``.

        Returns:
            The last answer of ``neighbours``; the moment it turns true starts ``SHARED_WAIT_S``.
        """
        now = time.monotonic()
        if now - self._neighbours_read >= NEIGHBOURS_TTL_S:
            self._neighbours_read = now
            shared = self._neighbours()
            if shared and not self._shared:
                self._shared_since = now
            self._shared = shared
        return self._shared

    def _admits(self, cost_mb: Optional[float]) -> bool:
        """Whether the call at the head of the queue may enter now; the caller holds the lock.

        Args:
            cost_mb: The call's memory in MB, or ``None`` when not known.

        Returns:
            True if it may enter.
        """
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
    """The guard with ``--modelserver``: admits every call at once."""

    def reserve(self, cost_mb: Optional[float]) -> contextlib.AbstractContextManager:
        """Admit the call at once.

        Args:
            cost_mb: Ignored.

        Returns:
            A context manager that does nothing.
        """
        return contextlib.nullcontext()


_NO_BUDGET = _NoBudget()
_budgets: Dict[str, DeviceBudget] = {}
_budgets_lock = threading.Lock()


def device_budget(device: str):
    """Return the process-wide guard of a device.

    Args:
        device: ``'cpu'``, ``'cuda'`` (taken as ``'cuda:0'``) or ``'cuda:N'``.

    Returns:
        The device's ``DeviceBudget``, created on first use; a no-op guard with ``--modelserver``.
    """
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
