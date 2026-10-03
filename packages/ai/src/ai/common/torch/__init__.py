import sys
from rocketlib import debug
from depends import load_depends

# The guard is a sys.meta_path hook, so it never sees the install: without this
# the CUDA wheel is fetched first and only then the import fails. Read through
# sys.modules because importing gpu_guard here pulls in ai.node and the SDK.
_guard = sys.modules.get('ai.common.models.gpu_guard')
if _guard is not None and _guard.is_installed():
    raise ImportError(
        'Direct import of "torch" is blocked in model server mode. '
        'GPU inference runs on the model server via ai.common.models. '
        'Do not import GPU libraries directly in nodes.'
    )

load_depends(__file__)

# We should have installed torch now
import torch

# Output debug message on GPU usage
if torch.cuda.is_available():
    debug('    GPU processing is enabled')
else:
    debug('    GPU processing disabled. Recommend using GPU for better performance.')


def probe_cuda(device_index: int = 0) -> bool:
    """Return True if CUDA compute kernels work on device_index, False otherwise.

    Catches cudaErrorNoKernelImageForDevice that surfaces when the PyTorch build
    does not include a kernel binary for the device's compute capability (e.g.
    Pascal sm_61 on a Quadro P620).  The probe executes a tiny GEMM and then
    calls synchronize() so any async CUDA error is raised here rather than
    silently deferred to the first real inference call.

    Scope: this is a torch-level probe, so it speaks only for loaders that run
    their kernels through torch. Runtimes with their own kernel builds need
    their own check; Whisper has one in WhisperLoader._check_gpu_compatible(),
    which probes ctranslate2 in a subprocess because a mismatch there aborts
    the process rather than raising. In practice an sm_* mismatch breaks the
    whole torch build, so a passing probe is good evidence for torch loaders.
    """
    if not torch.cuda.is_available():
        return False
    try:
        d = f'cuda:{device_index}'
        a = torch.randn(2, 2, device=d)
        _ = a @ a  # GEMM forces a compute kernel onto the device
        torch.cuda.synchronize(d)
        return True
    except Exception:
        return False


__all__ = ['torch', 'probe_cuda']
