# =============================================================================
# MIT License
#
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

import threading

from rocketlib import IGlobalBase, OPEN_MODE


class IGlobal(IGlobalBase):
    """
    IGlobal for the Face Detection node.

    Loads MediaPipe BlazeFace once at pipeline start and exposes a device
    lock for thread-safe inference across concurrent IInstance handlers.
    """

    def beginGlobal(self):
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return

        from depends import load_depends

        load_depends(__file__)

        from .face_detection import FaceDetector

        bag = self.IEndpoint.endpoint.bag

        self.detector = FaceDetector(self.glb.logicalType, self.glb.connConfig, bag)

        self.device_lock = threading.Lock()

    def endGlobal(self):
        detector = getattr(self, 'detector', None)
        if detector is not None:
            try:
                detector.close()
            except Exception:
                pass
        self.detector = None
        self.device_lock = None
