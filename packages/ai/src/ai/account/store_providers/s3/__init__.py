"""S3Store package."""

import os
from depends import depends

depends(os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt')

from .s3 import S3Store  # noqa: E402

__all__ = ['S3Store']
