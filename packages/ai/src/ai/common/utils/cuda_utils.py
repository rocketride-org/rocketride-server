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
Shared torch device/dtype detection for model loaders.

Centralizes the ``CUDA > MPS > CPU`` pick that the vision nodes each
duplicated (depth, detect, detect_segment, background_removal, ...). torch is
imported lazily via ``ai.common.torch`` so this module is import-safe under the
gpu_guard. Pose uses onnxruntime (not torch) and selects providers itself.
"""

from __future__ import annotations

import functools
import logging
from typing import Any, Optional, Tuple

logger = logging.getLogger('rocketlib.models.cuda')


def pick_torch_device() -> str:
    """Pick the best available torch device, lazy-importing torch.

    Returns:
        Device string, preferring 'cuda:0' > 'mps' > 'cpu'.
    """
    from ai.common.torch import torch

    if torch.cuda.is_available():
        return 'cuda:0'
    mps = getattr(torch.backends, 'mps', None)
    if mps is not None and mps.is_available():
        return 'mps'
    return 'cpu'


def pick_torch_dtype(device: str, *, cuda: str = 'float32', mps: str = 'float32', cpu: str = 'float32') -> Any:
    """Select a torch dtype for the given device's class.

    Args:
        device: Device string (e.g. 'cuda:0', 'mps', 'cpu'); only its class prefix matters.
        cuda: Torch dtype name to use on CUDA devices (default 'float32').
        mps: Torch dtype name to use on MPS devices (default 'float32').
        cpu: Torch dtype name to use on CPU (default 'float32').

    Returns:
        The torch dtype object (e.g. ``torch.float16``) for the matched class.
    """
    from ai.common.torch import torch

    d = str(device)
    name = cuda if d.startswith('cuda') else mps if d.startswith('mps') else cpu
    return getattr(torch, name)


def resolve_pipeline_device(device: Optional[str] = None) -> Tuple[Any, str]:
    """Map a device to the form a HF ``pipeline(device=...)`` call expects.

    Args:
        device: Canonical device string ('cuda:N', 'cuda', 'mps', 'cpu'), or
            None to auto-pick via :func:`pick_torch_device`.

    Returns:
        Tuple ``(pipeline_device, device_str)`` — pipeline_device is an int CUDA
        index, the string 'mps', or -1 for CPU; device_str is the canonical
        'cuda:N' / 'mps' / 'cpu' label.
    """
    if device is None:
        device = pick_torch_device()
    if device == 'cpu':
        return -1, device
    if device == 'mps':
        return 'mps', device
    if ':' in str(device):
        return int(str(device).split(':')[1]), str(device)
    if device == 'cuda':
        return 0, 'cuda:0'
    return device, str(device)


def select_torch_device(device: Any = None) -> Tuple[str, int]:
    """Pick the device a local-mode loader puts its model on, and check that it works.

    A CUDA device can be visible and still unable to run the model: when the
    installed torch has no kernels compiled for the GPU's architecture, loading
    succeeds and the first inference fails with cudaErrorNoKernelImageForDevice.
    So a CUDA device is used only once a small computation has run on it, and
    otherwise the model goes to the CPU. The check runs once per CUDA ordinal.

    Args:
        device: 'cuda', 'cuda:N', 'mps', 'cpu', a CUDA index (-1 for CPU, as
            a HF pipeline takes it), a ``torch.device``, or None to auto-pick
            via :func:`pick_torch_device`.

    Returns:
        Tuple ``(device_str, gpu_index)``: the canonical 'cuda:N' / 'mps' /
        'cpu' label, and the CUDA index N, or -1 for any other device.
    """
    if device is None:
        device = pick_torch_device()

    name = _canonical_device(device)
    if not name.startswith('cuda:'):
        return name, -1

    index = int(name.split(':')[1])
    if not _cuda_kernels_run(index):
        logger.warning(f'{name} cannot run the model; loading it on the CPU instead')
        return 'cpu', -1
    return name, index


def _canonical_device(device: Any) -> str:
    """Return a device as 'cuda:N', 'mps', 'cpu', or the string it was given."""
    if isinstance(device, bool):
        raise TypeError(f'Not a device: {device!r}')
    if isinstance(device, int):
        if device < 0:
            return 'cpu'
        return f'cuda:{device}'

    # str() of a torch.device is 'cuda:N', 'cuda', 'mps:N', 'mps', 'cpu:N' or 'cpu'
    name = str(device)

    # There is one CPU and one MPS device, so an index adds nothing; kept, it
    # would read as a CUDA index where a HF pipeline takes the device
    for kind in ('cpu', 'mps'):
        if name.startswith(f'{kind}:'):
            return kind

    # To torch, 'cuda' is the current device, which a loader may have set
    if name == 'cuda':
        return f'cuda:{_current_cuda_index()}'
    return name


def _current_cuda_index() -> int:
    """Return torch's current CUDA device, or 0 when CUDA is not available."""
    from ai.common.torch import torch

    if not torch.cuda.is_available():
        return 0
    return torch.cuda.current_device()


@functools.lru_cache(maxsize=None)
def _cuda_kernels_run(index: int) -> bool:
    """Return whether a computation runs on CUDA device ``index``.

    Allocation alone does not show it: a missing kernel image surfaces only
    when a compute kernel is launched, and asynchronously, so a matrix
    multiply is run and the device synchronized before the answer is trusted.
    """
    from ai.common.torch import torch

    if not torch.cuda.is_available():
        logger.warning('CUDA is not available')
        return False
    if index >= torch.cuda.device_count():
        logger.warning(f'There is no CUDA device {index}; {torch.cuda.device_count()} are visible')
        return False

    try:
        x = torch.ones((8, 8), device=f'cuda:{index}')
        (x @ x).sum().item()
        torch.cuda.synchronize(index)
    except RuntimeError as error:
        logger.warning(f'A computation on cuda:{index} failed: {error}')
        return False
    return True


def model_gpu_gb(model: Any) -> float:
    """Estimate GPU memory footprint of a torch model in GB.

    Works with raw nn.Module, dict bundles containing a 'model' key,
    and objects wrapping a .model attribute.  Returns 0.0 for
    non-torch objects (CPU-only nodes, proxy mode, etc.).
    """
    try:
        import torch.nn as nn

        # Unwrap bundle dicts and wrapper objects
        m = model
        if isinstance(m, dict):
            m = m.get('model', m)
        if not isinstance(m, nn.Module) and hasattr(m, 'model'):
            m = m.model
        if not isinstance(m, nn.Module):
            return 0.0

        total_bytes = sum(p.element_size() * p.nelement() for p in m.parameters())
        total_bytes += sum(b.element_size() * b.nelement() for b in m.buffers())
        return total_bytes / (1024**3)
    except Exception:
        return 0.0
