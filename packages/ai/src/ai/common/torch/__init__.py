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

__all__ = ['torch']
