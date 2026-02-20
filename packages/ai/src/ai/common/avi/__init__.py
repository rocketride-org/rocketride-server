import os
from depends import depends

requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
depends(requirements)

from .reader import AVIReader
from .frame import VideoFrameExtractor

__all__ = ['AVIReader', 'VideoFrameExtractor']
