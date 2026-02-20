import os
from depends import depends

requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
depends(requirements)

from .image import Image, ImageProcessor

__all__ = ['Image', 'ImageProcessor']
