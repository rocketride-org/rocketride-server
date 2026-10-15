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

__all__ = ['torch']
