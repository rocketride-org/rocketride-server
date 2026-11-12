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

from rocketlib import IGlobalBase

from .face_detection import FaceDetector


class IGlobal(IGlobalBase):
    """
    IGlobal for the Face Detection node.

    Loads MediaPipe BlazeFace once at pipeline start and exposes a device
    lock for thread-safe inference across concurrent IInstance handlers.
    """

    def beginGlobal(self):
        """Build the detector from the resolved config (threshold bounded by the schema)."""
        config = self.config
        self.detector = FaceDetector(config.threshold, config.emit_landmarks)

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
