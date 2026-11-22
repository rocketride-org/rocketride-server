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
Global handler for the Object Detection node.

The control's configuration picks the backend (the selected profile's
``engine`` constant), which is the model whose weights load here, once per
control. The threshold and the prompt are per-call parameters: the instance
reads them from its settings and passes them to ``Detector.detect``.
"""

from rocketlib import IGlobalBase
from ai.common.models.base import make_device_lock
from ai.common.models.vision.detection import Detector


class IGlobal(IGlobalBase):
    """One control's detector: the loaded backend and the lock that serializes local inference."""

    detector = None
    device_lock = None

    def beginGlobal(self):
        """Build the shared Detector facade for the control's backend.

        The selected profile pins the backend engine, which is the model
        identity. The facade's own threshold and prompt stay at their defaults:
        every call passes its own.
        """
        self.detector = Detector(backend=self.config.engine, device=None)

        # Local inference must serialize GPU access
        self.device_lock = make_device_lock()

    def endGlobal(self):
        """Disconnect the facade and release shared state on teardown."""
        if self.detector is not None:
            self.detector.disconnect()
        self.detector = None
        self.device_lock = None
