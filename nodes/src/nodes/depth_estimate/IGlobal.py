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
Global handler for the Depth Estimation node.

The control's profile pins the model and its revision, which are the weights
loaded here once per control. The inference edge is a per-call parameter: the
instance reads it from its settings and resizes each frame before the
estimator sees it.
"""

from rocketlib import IGlobalBase
from ai.common.models.base import make_device_lock
from ai.common.models.vision.depth import DepthEstimator


class IGlobal(IGlobalBase):
    """One control's depth estimator: the loaded model and the lock that serializes local inference."""

    estimator = None
    device_lock = None

    def beginGlobal(self):
        """Build the shared DepthEstimator facade for the control's profile.

        The selected profile pins the model and its revision.
        """
        config = self.config

        # device=None -> model server when --modelserver is set, else local.
        self.estimator = DepthEstimator(config.model, device=None, revision=config.revision)

        # Local inference must serialize GPU access
        self.device_lock = make_device_lock()

    def endGlobal(self):
        """Disconnect the facade and release shared state on teardown."""
        if self.estimator is not None:
            self.estimator.disconnect()
        self.estimator = None
        self.device_lock = None
