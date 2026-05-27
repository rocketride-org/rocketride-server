import os

from rocketlib import debug
from depends import depends, has_nvidia_gpu

_torch_dir = os.path.dirname(os.path.realpath(__file__))
if has_nvidia_gpu():
    debug('NVIDIA GPU detected — installing CUDA torch build')
    _requirements = os.path.join(_torch_dir, 'requirements_gpu.txt')
else:
    debug('No NVIDIA GPU detected — installing CPU-only torch build')
    _requirements = os.path.join(_torch_dir, 'requirements_cpu.txt')

depends(_requirements)

# We should have installed torch now
import torch

# Output debug message on GPU usage
if torch.cuda.is_available():
    debug('    GPU processing is enabled')
else:
    debug('    GPU processing disabled. Recommend using GPU for better performance.')

__all__ = ['torch']
