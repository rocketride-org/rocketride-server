# =============================================================================
# MIT License
# Copyright (c) 2024 RocketRide Inc.
# =============================================================================
"""
OpenCV wrapper that ensures opencv-contrib-python is installed.

This is the most complete OpenCV variant, providing:
- GUI support (highgui)
- All contrib modules like ximgproc (needed by img2table for niBlackThreshold)
- numpy 2.x ABI compatibility (when >=4.13)

Usage:
    from ai.common.opencv import cv2

    # Now use cv2 as normal
    image = cv2.imread('image.png')

Import this BEFORE modules that use opencv internally (img2table, easyocr, etc.)
to ensure the correct version is installed first.

IMPORTANT: All four opencv PyPI packages (opencv-python, opencv-python-headless,
opencv-contrib-python, opencv-contrib-python-headless) share the same cv2 namespace.
Only one can be active at a time. This module ensures opencv-contrib-python is the
one installed, uninstalling any conflicting variants.
"""

import os
from depends import depends

# Install the modules that are subsets
requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements_1.txt'
depends(requirements)

# Now, install the full module which contains everything
requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements_2.txt'
depends(requirements)

# Import cv2
import cv2

__all__ = ['cv2']
