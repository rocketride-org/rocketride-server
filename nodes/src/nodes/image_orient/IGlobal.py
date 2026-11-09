# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================

import os
from typing import Callable

from depends import depends

# orient/detect import cv2 at module scope, so the requirements are installed
# before they are imported. This module is only imported on the run path
# (config mode imports the validator alone), so the install never runs while a
# user is merely opening the node's settings panel.
depends(os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt')

from rocketlib import IGlobalBase

from .orient import build_orient


class IGlobal(IGlobalBase):
    """
    Process-wide setup: resolve config once, fetch the model once, bind the algorithm.

    Nothing here touches an image. Its job is to make ``orient`` available to every instance with
    the tunables and the loaded detector already baked in, so per-object work never re-parses
    config and never re-reads a model from disk.
    """

    # orient(image_bytes, mime, want_image) -> (out_bytes | None, record) | None
    orient: Callable = None

    def beginGlobal(self) -> None:
        """Bind the algorithm over the resolved tunables (defaults and bounds applied by the resolver)."""
        self.orient = build_orient(self.config)

    def endGlobal(self) -> None:
        """Release the detector the bound callable closes over."""
        self.orient = None
