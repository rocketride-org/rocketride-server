# =============================================================================
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
Hardware probe and ``requiresHardware`` checks for local-inference workloads.

``probe_hardware`` predicts the machine class ``pick_torch_device`` resolves to
(``cuda`` > ``mps`` > ``cpu``) without importing torch: NVML for NVIDIA GPUs,
the platform for Apple Silicon, psutil for memory.

A requirement names the machine classes a workload may run on and the memory
each needs::

    {'cuda': {'vramGb': 11}, 'mps': {'ramGb': 32, 'timeout': 1800}, 'cpu': false}

Classes not listed are not allowed. ``vramGb`` is the free VRAM needed on
cuda:0; ``ramGb`` is total system memory (unified memory on Apple Silicon).
"""

from __future__ import annotations

import math
import os
import platform
import sys
from dataclasses import asdict, dataclass, field
from typing import Any, Dict, List, Mapping, Optional, Tuple

DEVICE_CLASSES = ('cuda', 'mps', 'cpu')

# torch is installed as the cu128 build (ai/common/torch/requirements.txt), which
# runs on any CUDA 12+ driver via minor-version compatibility.
_MIN_CUDA_DRIVER = 12000

_GIB = 1024**3
_MAX_RESIDENTS = 6
_DEVICE_KEYS = {'cuda': {'vramGb', 'ramGb', 'timeout'}, 'mps': {'ramGb', 'timeout'}, 'cpu': {'ramGb', 'timeout'}}


@dataclass
class CudaMemory:
    """Memory of the GPU that backs cuda:0.

    When several GPUs may be cuda:0 (see ``_cuda0_candidates``), the figures are
    the smallest across them.

    Attributes:
        name: GPU model name, or ``'one of A, B'`` when ambiguous.
        total_gb: Total VRAM in GiB, or None when it could not be read.
        free_gb: Free VRAM in GiB, or None when it could not be read.
        residents: Processes holding VRAM, largest first (``'name[pid] N GB'``).
    """

    name: str
    total_gb: Optional[float]
    free_gb: Optional[float]
    residents: List[str] = field(default_factory=list)


@dataclass
class HardwareSnapshot:
    """What a workload started now would run on.

    Attributes:
        device: Machine class ``'cuda'``, ``'mps'`` or ``'cpu'``; None when unknown.
        name: GPU or CPU name.
        vram_total_gb: Total VRAM of cuda:0 in GiB (cuda only).
        vram_free_gb: Free VRAM of cuda:0 in GiB (cuda only).
        ram_total_gb: Total system memory in GiB.
        ram_available_gb: Available system memory in GiB.
        residents: Processes holding VRAM, largest first (cuda only).
        source: ``'probe'`` (this machine), ``'env'`` (caller-supplied) or ``'unknown'``.
        note: Why the device is unknown, when it is.
    """

    device: Optional[str]
    name: str = ''
    vram_total_gb: Optional[float] = None
    vram_free_gb: Optional[float] = None
    ram_total_gb: Optional[float] = None
    ram_available_gb: Optional[float] = None
    residents: List[str] = field(default_factory=list)
    source: str = 'probe'
    note: str = ''

    def to_dict(self) -> Dict[str, Any]:
        """Return a JSON-serialisable copy (e.g. to hand to another process).

        Returns:
            Dict with one entry per attribute.
        """
        return asdict(self)

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> 'HardwareSnapshot':
        """Rebuild a snapshot from :meth:`to_dict` output.

        Args:
            data: Mapping produced by :meth:`to_dict`.

        Returns:
            The equivalent snapshot.
        """
        return cls(**dict(data))

    def describe(self) -> str:
        """Summarise the snapshot on one line.

        Returns:
            E.g. ``'cuda RTX 4090, 24.0 GB VRAM (22.5 GB free), 64.0 GB RAM [probe]'``.
        """
        if self.device is None:
            return f'unknown ({self.note})' if self.note else 'unknown'
        parts = [self.device]
        if self.name:
            parts.append(self.name)
        mem = []
        if self.vram_total_gb is not None:
            vram = f'{self.vram_total_gb:.1f} GB VRAM'
            if self.vram_free_gb is not None:
                vram += f' ({self.vram_free_gb:.1f} GB free)'
            mem.append(vram)
        if self.ram_total_gb is not None:
            mem.append(f'{self.ram_total_gb:.1f} GB RAM')
        text = ' '.join(parts)
        if mem:
            text += ', ' + ', '.join(mem)
        return f'{text} [{self.source}]'


@dataclass(frozen=True)
class DeviceRequirement:
    """Minimums for one allowed machine class.

    Attributes:
        vram_gb: Free VRAM needed on cuda:0, in GiB (cuda only).
        ram_gb: Total system memory needed, in GiB.
        timeout: Seconds the workload may take on this class.
    """

    vram_gb: Optional[float] = None
    ram_gb: Optional[float] = None
    timeout: Optional[int] = None


@dataclass(frozen=True)
class HardwareRequirement:
    """Allowed machine classes and their minimums.

    Attributes:
        devices: Allowed class name -> its minimums. Classes absent here are not allowed.
    """

    devices: Mapping[str, DeviceRequirement]

    def need_gb(self, device: Optional[str]) -> Optional[float]:
        """Memory the workload consumes on ``device``.

        Args:
            device: Machine class name, or None.

        Returns:
            ``vram_gb`` on cuda, ``ram_gb`` elsewhere; None when the class is not
            allowed or declares no minimum.
        """
        req = self.devices.get(device) if device else None
        if req is None:
            return None
        return req.vram_gb if device == 'cuda' else req.ram_gb


@dataclass(frozen=True)
class HardwareCheck:
    """Outcome of :func:`check_hardware`.

    Attributes:
        ok: Whether the requirement is met.
        reason: Why it is not met (empty when ``ok``).
        device: The machine class that was checked.
        timeout: The class's declared timeout, when met.
        need_gb: Memory the workload consumes on that class, when met.
    """

    ok: bool
    reason: str = ''
    device: Optional[str] = None
    timeout: Optional[int] = None
    need_gb: Optional[float] = None


def parse_hardware_requirement(value: Any) -> Optional[HardwareRequirement]:
    """Parse a ``requiresHardware`` value from services.json.

    Args:
        value: The raw JSON value. ``None`` (absent) and ``False`` mean the
            workload needs no special hardware.

    Returns:
        The parsed requirement, or None when there is none.

    Raises:
        ValueError: The value is malformed (unknown keys, wrong types, nothing allowed).
    """
    if value is None or value is False:
        return None
    if not isinstance(value, dict):
        raise ValueError(f'expected an object or false, got {type(value).__name__}')
    unknown = sorted(set(value) - set(DEVICE_CLASSES))
    if unknown:
        raise ValueError(f'unknown machine class(es) {unknown}; expected {list(DEVICE_CLASSES)}')

    devices: Dict[str, DeviceRequirement] = {}
    for device, spec in value.items():
        if spec is False:
            continue
        if spec is True:
            spec = {}
        if not isinstance(spec, dict):
            raise ValueError(f'{device}: expected an object, true or false, got {type(spec).__name__}')
        bad = sorted(set(spec) - _DEVICE_KEYS[device])
        if bad:
            raise ValueError(f'{device}: unknown key(s) {bad}; expected {sorted(_DEVICE_KEYS[device])}')
        devices[device] = DeviceRequirement(
            vram_gb=_positive(spec, 'vramGb', device, float),
            ram_gb=_positive(spec, 'ramGb', device, float),
            timeout=_positive(spec, 'timeout', device, int),
        )
    if not devices:
        raise ValueError('no machine class is allowed')
    return HardwareRequirement(devices=devices)


def _positive(spec: Dict[str, Any], key: str, device: str, kind: type) -> Any:
    """Read an optional positive number from a device entry.

    Args:
        spec: The device entry (e.g. ``{"vramGb": 11}``).
        key: Key to read.
        device: Machine class name, for error messages.
        kind: ``float`` or ``int``; ``int`` also rejects fractions.

    Returns:
        The value converted to ``kind``, or None when the key is absent.

    Raises:
        ValueError: The value is not a positive number of the right kind.
    """
    if key not in spec:
        return None
    value = spec[key]
    # bool is an int subclass; json.loads reads NaN and Infinity, which no comparison rejects.
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
        raise ValueError(f'{device}.{key}: expected a positive number, got {value!r}')
    if kind is int and value != int(value):
        raise ValueError(f'{device}.{key}: expected whole seconds, got {value!r}')
    return kind(value)


def check_hardware(requirement: HardwareRequirement, snapshot: HardwareSnapshot) -> HardwareCheck:
    """Decide whether ``snapshot`` satisfies ``requirement``.

    Only the snapshot's own machine class is considered: a CUDA machine whose GPU
    is too small fails even if ``cpu`` is allowed, because torch would still pick
    the GPU.

    Args:
        requirement: Parsed ``requiresHardware``.
        snapshot: The machine to check.

    Returns:
        The outcome; ``reason`` explains a failure in one line.
    """
    device = snapshot.device
    allowed = '/'.join(d for d in DEVICE_CLASSES if d in requirement.devices)
    if device is None:
        return HardwareCheck(False, f'hardware unknown: {snapshot.note or "no probe result"}')
    spec = requirement.devices.get(device)
    if spec is None:
        return HardwareCheck(False, f'runs on {allowed} only; this machine is {device} ({snapshot.name})', device)

    if spec.vram_gb is not None:
        if snapshot.vram_total_gb is None:
            return HardwareCheck(False, f'needs {spec.vram_gb:g} GB VRAM; VRAM unknown', device)
        if snapshot.vram_total_gb < spec.vram_gb:
            return HardwareCheck(
                False,
                f'needs {spec.vram_gb:g} GB VRAM; {snapshot.name} has {snapshot.vram_total_gb:.1f} GB',
                device,
            )
        if snapshot.vram_free_gb is not None and snapshot.vram_free_gb < spec.vram_gb:
            reason = (
                f'needs {spec.vram_gb:g} GB free VRAM; only {snapshot.vram_free_gb:.1f} GB of '
                f'{snapshot.vram_total_gb:.1f} GB free at session start'
            )
            if snapshot.residents:
                reason += f' (held by: {", ".join(snapshot.residents)})'
            return HardwareCheck(False, reason, device)

    if spec.ram_gb is not None:
        if snapshot.ram_total_gb is None:
            return HardwareCheck(False, f'needs {spec.ram_gb:g} GB RAM; RAM unknown', device)
        if snapshot.ram_total_gb < spec.ram_gb:
            return HardwareCheck(
                False, f'needs {spec.ram_gb:g} GB RAM; this machine has {snapshot.ram_total_gb:.1f} GB', device
            )

    return HardwareCheck(True, device=device, timeout=spec.timeout, need_gb=requirement.need_gb(device))


def probe_hardware() -> HardwareSnapshot:
    """Probe this machine without importing torch.

    Returns:
        A ``source='probe'`` snapshot: cuda when torch would use an NVIDIA GPU,
        else mps on Apple Silicon, else cpu.
    """
    ram_total, ram_available = _ram_gb()
    cuda = probe_cuda_memory()
    if cuda is not None:
        return HardwareSnapshot(
            device='cuda',
            name=cuda.name,
            vram_total_gb=cuda.total_gb,
            vram_free_gb=cuda.free_gb,
            ram_total_gb=ram_total,
            ram_available_gb=ram_available,
            residents=cuda.residents,
        )
    device = 'mps' if _is_apple_silicon() else 'cpu'
    name = 'Apple Silicon' if device == 'mps' else (platform.processor() or platform.machine())
    return HardwareSnapshot(device=device, name=name, ram_total_gb=ram_total, ram_available_gb=ram_available)


def probe_cuda_memory() -> Optional[CudaMemory]:
    """Read the memory of the GPU torch would use as cuda:0, through NVML.

    Returns:
        The GPU's memory, or None when torch would not use CUDA (no NVML, no
        visible GPU, or a driver older than CUDA 12). ``total_gb`` and
        ``free_gb`` are None when the GPU is visible but its memory is not
        readable, e.g. a MIG instance NVML cannot resolve.
    """
    try:
        import pynvml

        pynvml.nvmlInit()
    except Exception:
        return None
    # Separate block: nvmlShutdown is only valid after a successful nvmlInit.
    try:
        if pynvml.nvmlSystemGetCudaDriverVersion() < _MIN_CUDA_DRIVER:
            return None
        handles, unresolved = _cuda0_candidates(pynvml)
        if unresolved:
            return CudaMemory(name=unresolved, total_gb=None, free_gb=None)
        if not handles:
            return None
        infos = []
        for handle in handles:
            mem = pynvml.nvmlDeviceGetMemoryInfo(handle)
            infos.append((_text(pynvml.nvmlDeviceGetName(handle)), mem.total / _GIB, mem.free / _GIB, handle))
        names = sorted({info[0] for info in infos})
        total = min(info[1] for info in infos)
        free = min(info[2] for info in infos)
        name = names[0] if len(names) == 1 else 'one of ' + ', '.join(names)
        return CudaMemory(
            name=name,
            total_gb=round(total, 2),
            free_gb=round(free, 2),
            residents=_residents(pynvml, [info[3] for info in infos]),
        )
    except Exception:
        return None
    finally:
        try:
            pynvml.nvmlShutdown()
        except Exception:
            pass


def _cuda0_candidates(nvml: Any) -> Tuple[List[Any], Optional[str]]:
    """Find the NVML devices that may be cuda:0.

    NVML enumerates in PCI order while CUDA defaults to fastest-first, so an index
    only maps exactly with ``CUDA_DEVICE_ORDER=PCI_BUS_ID`` or a single GPU. When
    the mapping is ambiguous every device is returned and the caller takes the
    smallest.

    Args:
        nvml: The initialised ``pynvml`` module.

    Returns:
        ``(handles, unresolved)``. ``handles`` are the candidate devices, empty
        when ``CUDA_VISIBLE_DEVICES`` hides all GPUs. ``unresolved`` names a
        selector that points at a GPU NVML could not resolve, and the caller then
        reports unknown memory rather than another device's.
    """
    count = nvml.nvmlDeviceGetCount()
    handles = [nvml.nvmlDeviceGetHandleByIndex(i) for i in range(count)]
    if not handles:
        return [], None
    pci_order = os.environ.get('CUDA_DEVICE_ORDER', '').upper() == 'PCI_BUS_ID'

    visible = os.environ.get('CUDA_VISIBLE_DEVICES')
    if visible is None:
        return (handles[:1] if pci_order or count == 1 else handles), None

    selector = visible.split(',')[0].strip()
    if not selector:
        return [], None
    if selector.lstrip('-').isdigit():
        index = int(selector)
        if index < 0 or index >= count:
            return [], None
        return ([handles[index]] if pci_order or count == 1 else handles), None
    if selector.startswith('MIG-'):
        # A MIG instance holds a fraction of its parent's memory, so the parent's
        # figures would overstate it. Read the instance itself or nothing.
        for uuid in (selector.encode(), selector):
            try:
                handle = nvml.nvmlDeviceGetHandleByUUID(uuid)
                nvml.nvmlDeviceGetMemoryInfo(handle)
                return [handle], None
            except Exception:
                continue
        return [], selector
    if selector.startswith('GPU-'):
        for handle in handles:
            if _text(nvml.nvmlDeviceGetUUID(handle)).startswith(selector):
                return [handle], None
        return [], None
    # Other selectors: cannot map, stay conservative.
    return handles, None


def _residents(nvml: Any, handles: List[Any]) -> List[str]:
    """List the processes holding memory on ``handles``.

    Args:
        nvml: The initialised ``pynvml`` module.
        handles: Devices to inspect.

    Returns:
        ``'name[pid] N GB'`` entries (no size where the driver does not report one,
        as on Windows), largest first, engine/python processes before others among
        equals, capped with a ``'+N more'`` entry.
    """
    found: Dict[int, Optional[int]] = {}
    for handle in handles:
        for getter in ('nvmlDeviceGetComputeRunningProcesses', 'nvmlDeviceGetGraphicsRunningProcesses'):
            try:
                procs = getattr(nvml, getter)(handle)
            except Exception:
                continue
            for proc in procs:
                used = proc.usedGpuMemory
                if used is not None and used >= 2**63:  # NVML_VALUE_NOT_AVAILABLE
                    used = None
                if found.get(proc.pid) is None:
                    found[proc.pid] = used

    rows = []
    for pid, used in found.items():
        name = _process_name(pid)
        likely_ml = name.lower().startswith(('engine', 'python'))
        rows.append((used is None, -(used or 0), not likely_ml, name, pid, used))
    rows.sort()
    out = [
        f'{name}[{pid}] {used / _GIB:.1f} GB' if used is not None else f'{name}[{pid}]'
        for *_, name, pid, used in rows[:_MAX_RESIDENTS]
    ]
    if len(rows) > _MAX_RESIDENTS:
        out.append(f'+{len(rows) - _MAX_RESIDENTS} more')
    return out


def _process_name(pid: int) -> str:
    """Name a process.

    Args:
        pid: Process id.

    Returns:
        The executable name, or ``'?'`` when it cannot be read.
    """
    try:
        import psutil

        return psutil.Process(pid).name()
    except Exception:
        return '?'


def _ram_gb() -> Tuple[Optional[float], Optional[float]]:
    """Read system memory.

    Returns:
        ``(total, available)`` in GiB, or ``(None, None)`` without psutil.
    """
    try:
        import psutil

        mem = psutil.virtual_memory()
        return round(mem.total / _GIB, 2), round(mem.available / _GIB, 2)
    except Exception:
        return None, None


def _is_apple_silicon() -> bool:
    """Whether this is macOS on arm64, where torch uses MPS.

    Returns:
        True on Apple Silicon.
    """
    return sys.platform == 'darwin' and platform.machine() == 'arm64'


def _text(value: Any) -> str:
    """Decode an NVML string, which older pynvml versions return as bytes.

    Args:
        value: ``str`` or ``bytes``.

    Returns:
        The text.
    """
    return value.decode() if isinstance(value, bytes) else str(value)
