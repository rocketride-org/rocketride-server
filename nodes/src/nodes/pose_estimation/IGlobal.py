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

from rocketlib import IGlobalBase

from ai.common.models.base import make_device_lock
from ai.common.models.vision.pose import PROFILE_TO_MODE, PoseEstimator


class IGlobal(IGlobalBase):
    pose_estimator = None
    device_lock = None
    threshold: float = 0.3

    def beginGlobal(self):
        """Build the shared PoseEstimator facade from the resolved config (model, threshold, max_persons).

        The schema supplies the defaults and the bounds, so the values are
        read as they are.
        """
        config = self.config
        self.threshold = float(config.threshold)

        # device=None -> model server when --modelserver is set, else local.
        self.pose_estimator = PoseEstimator(
            mode=PROFILE_TO_MODE[config.model],
            device=None,
            threshold=self.threshold,
            max_persons=int(config.max_persons),
        )

        # Local inference must serialize GPU access
        self.device_lock = make_device_lock()

    def endGlobal(self):
        """Disconnect the facade and release shared state on teardown."""
        if self.pose_estimator is not None:
            self.pose_estimator.disconnect()
        self.pose_estimator = None
        self.device_lock = None
