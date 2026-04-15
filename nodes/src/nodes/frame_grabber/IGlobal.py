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

import threading
from rocketlib import IGlobalBase, IJson
from ai.common.config import Config


class IGlobal(IGlobalBase):
    def beginGlobal(self):
        # Mutex if this driver requires physical devices
        self.device_lock = threading.Lock()

        # Get and save the config info — convert to plain dict so user-supplied values
        # (interval, duration, start_time) survive the IJson merge and are mutable.
        self.config = IJson.toDict(Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig))

        # Put the profile (type) in there as well
        self.config['type'] = self.glb.connConfig.get('profile', 'interval')

        # Translate interval (seconds between frames) to fps for VideoFrameExtractor,
        # which only reads 'fps' and never reads 'interval'
        interval = self.config.get('interval')
        if interval is not None:
            if interval <= 0:
                raise ValueError(f'interval must be positive, got {interval}')
            self.config['fps'] = 1.0 / interval

    def endGlobal(self):
        # Release the lock
        self.device_lock = None
