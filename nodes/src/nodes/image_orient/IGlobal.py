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

from ai.common.config import Config
from rocketlib import IGlobalBase, OPEN_MODE


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
        """
        Return early in config mode, install dependencies, then import the imaging code.

        The order is load-bearing rather than stylistic:

        * The ``OPEN_MODE.CONFIG`` early return matters more here than in a node with no model.
          Without it, merely opening this node's settings panel in the extension would download
          the detector.
        * ``orient``/``detect`` import cv2 at module scope, so importing either before
          ``depends()`` has run would reach for a package that is not installed yet. Keeping them
          out of this module's own import block is also what lets the unit tests import
          ``IInstance`` under the engine's bundled Python, which carries neither cv2 nor Pillow.
        """
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return

        config = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)

        from depends import depends

        requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
        depends(requirements)

        from .orient import build_orient

        self.orient = build_orient(config)

    def endGlobal(self) -> None:
        """Release the detector the bound callable closes over."""
        self.orient = None
