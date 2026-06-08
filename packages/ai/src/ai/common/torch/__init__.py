import os
from rocketlib import debug
from depends import depends

requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
depends(requirements)

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
