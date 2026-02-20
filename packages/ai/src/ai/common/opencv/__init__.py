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

import importlib.metadata
from rocketlib import debug
from depends import pip

# Ensure opencv-contrib-python is installed (the most complete variant,
# includes GUI + all contrib modules like ximgproc).
# Other opencv packages (opencv-python, opencv-python-headless, etc.)
# conflict by overwriting cv2 modules, so we uninstall them first.
_DESIRED_PACKAGE = 'opencv-contrib-python'
_CONFLICTING_PACKAGES = [
    'opencv-python',
    'opencv-python-headless',
    'opencv-contrib-python-headless',
]

_MIN_VERSION = '4.13'
_needs_install = False

try:
    _installed_version = importlib.metadata.version(_DESIRED_PACKAGE)
    if tuple(int(x) for x in _installed_version.split('.')[:2]) >= tuple(int(x) for x in _MIN_VERSION.split('.')):
        debug(f'{_DESIRED_PACKAGE}=={_installed_version} is already installed')
    else:
        debug(f'{_DESIRED_PACKAGE}=={_installed_version} is too old (need >={_MIN_VERSION})')
        _needs_install = True
except importlib.metadata.PackageNotFoundError:
    debug(f'{_DESIRED_PACKAGE} not found')
    _needs_install = True

if _needs_install:
    debug(f'Installing {_DESIRED_PACKAGE}>={_MIN_VERSION}...')
    # Install conflicting opencv packages first
    for pkg in _CONFLICTING_PACKAGES + [_DESIRED_PACKAGE]:
        pip('install', f'{pkg}>={_MIN_VERSION}')

# Import cv2
import cv2

__all__ = ['cv2']
