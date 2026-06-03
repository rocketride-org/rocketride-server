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
import threading

from rocketlib import IGlobalBase, OPEN_MODE


class IGlobal(IGlobalBase):
    """
    IGlobal manages global lifecycle for the Segmentation (``detect_segment``) node.

    Constructs the configured Segmenter (mode + engine) once at pipeline
    start and provides a device lock for thread-safe inference across
    concurrent IInstance handlers.

    Mode/engine defaults:
      - mode = ``instance`` (default) or ``semantic``.
      - Engine is Mask2Former (MIT, HuggingFace, CPU/MPS/CUDA).
    """

    def beginGlobal(self):
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return

        from depends import depends

        requirements = os.path.join(os.path.dirname(os.path.realpath(__file__)), 'requirements.txt')
        depends(requirements)

        import ai.common.torch  # noqa: F401

        from .detect_segment import Segmenter

        bag = self.IEndpoint.endpoint.bag

        self.segmenter = Segmenter(self.glb.logicalType, self.glb.connConfig, bag)

        self.device_lock = threading.Lock()

    def endGlobal(self):
        self.segmenter = None
        self.device_lock = None
