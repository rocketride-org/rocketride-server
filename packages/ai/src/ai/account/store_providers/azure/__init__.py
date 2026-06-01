"""AzureBlobStore package."""

import os
from depends import depends

depends(os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt')

from .azure import AzureBlobStore  # noqa: E402

__all__ = ['AzureBlobStore']
