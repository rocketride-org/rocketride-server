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

from depends import load_depends

load_depends(__file__)

from rocketlib import IGlobalBase


class IGlobal(IGlobalBase):
    #: The extractor's config: the resolved node config as a plain dict plus
    #: the two keys VideoFrameExtractor reads under other names.
    grab_config: dict = {}

    def beginGlobal(self):
        """Build the extractor config from the resolved node config.

        The selected mode flattens to its own leaves (interval, percent,
        min_scene_gap, max_frames) beside the shared ones (start_time,
        duration, watermark); the resolver applied every default and bounded
        the interval above zero.
        """
        # Mutex if this driver requires physical devices
        self.device_lock = threading.Lock()

        config = self.config
        self.grab_config = dict(config)

        # VideoFrameExtractor reads the mode as 'type'
        self.grab_config['type'] = config.profile

        # Translate interval (seconds between frames) to fps for VideoFrameExtractor,
        # which only reads 'fps' and never reads 'interval'
        if 'interval' in config:
            self.grab_config['fps'] = 1.0 / config.interval

    def endGlobal(self):
        # Release the lock
        self.device_lock = None
