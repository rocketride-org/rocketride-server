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

from rocketlib import IGlobalBase


class IGlobal(IGlobalBase):
    """
    Process-wide setup for the scan cropper: install the imaging dependencies, hold nothing.

    Every tunable (the scan type and its detection values, deskew, the crop quality) is a
    per-call parameter: each call binds its own settings into ``split_scan`` (see
    ``IInstance.beginInstance``). There is no model or handle to keep.
    """

    def beginGlobal(self) -> None:
        """
        Install the dependencies the imaging code imports at module scope.

        The import order is load-bearing rather than stylistic. ``process``/``detect``/``geometry``
        import cv2 at module scope, so importing any of them before ``depends()`` has run would
        reach for a package that is not installed yet. Keeping them out of this module's own
        import block is also what lets the node's unit tests import ``IInstance`` under the
        engine's bundled Python, which carries neither cv2 nor Pillow.
        """
        from depends import depends

        requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
        depends(requirements)
