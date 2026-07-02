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

from rocketlib import IGlobalBase, OPEN_MODE, warning
from ai.common.config import Config

DEFAULT_PROFILE = 'rtmpose-medium'
DEFAULT_THRESHOLD = 0.3
DEFAULT_MAX_PERSONS = 20


class IGlobal(IGlobalBase):
    pose_estimator = None
    device_lock = None
    threshold = DEFAULT_THRESHOLD

    def beginGlobal(self):
        """Build the shared PoseEstimator facade from node config (profile/threshold/max_persons)."""
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return

        from ai.common.models.vision.pose import PoseEstimator, PROFILE_TO_MODE, DEFAULT_MODE

        config = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)

        profile = str(config.get('profile', DEFAULT_PROFILE)).lower().strip()
        mode = PROFILE_TO_MODE.get(profile, DEFAULT_MODE)
        if profile not in PROFILE_TO_MODE:
            warning(f'pose_estimation: unknown profile "{profile}", falling back to {DEFAULT_MODE}.')

        raw_threshold = config.get('threshold', DEFAULT_THRESHOLD)
        try:
            self.threshold = float(raw_threshold)
        except (TypeError, ValueError):
            self.threshold = None
        if self.threshold is None or not (0.0 <= self.threshold <= 1.0):
            warning(f'pose_estimation: invalid threshold {raw_threshold!r}, using default {DEFAULT_THRESHOLD}')
            self.threshold = DEFAULT_THRESHOLD
        try:
            max_persons = int(config.get('max_persons', DEFAULT_MAX_PERSONS))
        except (TypeError, ValueError):
            max_persons = DEFAULT_MAX_PERSONS
        max_persons = min(200, max(1, max_persons))

        # device=None -> model server when --modelserver is set, else local.
        self.pose_estimator = PoseEstimator(mode=mode, device=None, threshold=self.threshold, max_persons=max_persons)

        # Local inference must serialize GPU access
        from ai.common.models.base import make_device_lock

        self.device_lock = make_device_lock()

    def endGlobal(self):
        """Disconnect the facade and release shared state on teardown."""
        if self.pose_estimator is not None:
            self.pose_estimator.disconnect()
        self.pose_estimator = None
        self.device_lock = None
