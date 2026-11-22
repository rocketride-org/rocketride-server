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

"""
Global handler for the Face Detection node.

The confidence threshold and the landmark flag are per-call parameters. The
threshold is bound into a MediaPipe detector when it is built, so the control
keeps a small bounded cache of detectors keyed by threshold, built on first
use and closed when evicted or when the control ends. Every use of a detector
(build, detect, evict) happens under the device lock.
"""

import threading
from collections import OrderedDict

from rocketlib import IGlobalBase

from .face_detection import FaceDetector

# ==== Constants ==================================================================

#: The most detectors one control keeps; the least recently used is closed first.
MAX_DETECTORS = 4


class IGlobal(IGlobalBase):
    """
    IGlobal for the Face Detection node.

    Holds the device lock and the bounded cache of MediaPipe BlazeFace
    detectors, one per threshold a call has asked for.
    """

    def beginGlobal(self):
        """Create the device lock and the empty detector cache."""
        self.device_lock = threading.Lock()
        self.detectors = OrderedDict()

    def detector_for(self, threshold: float) -> FaceDetector:
        """
        The detector for one threshold, built on first use; call under ``device_lock``.

        Args:
            threshold: The call's minimum detection confidence.

        Returns:
            The cached or newly built detector.
        """
        key = float(threshold)
        detector = self.detectors.get(key)
        if detector is not None:
            self.detectors.move_to_end(key)
            return detector

        # Build the new one, then evict the least recently used past the bound
        detector = FaceDetector(key)
        self.detectors[key] = detector
        while len(self.detectors) > MAX_DETECTORS:
            _, evicted = self.detectors.popitem(last=False)
            evicted.close()
        return detector

    def endGlobal(self):
        """Close every cached detector and drop the lock."""
        detectors = getattr(self, 'detectors', None) or {}
        for detector in detectors.values():
            try:
                detector.close()
            except Exception:
                pass
        self.detectors = None
        self.device_lock = None
