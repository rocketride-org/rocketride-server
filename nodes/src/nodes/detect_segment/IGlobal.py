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

from depends import load_depends

# pycocotools is needed client-side for RLE restore + overlay rendering,
# even when inference is proxied to the model server.
load_depends(__file__)

from rocketlib import IGlobalBase, warning
from ai.common.models.base import make_device_lock
from ai.common.models.vision.segmentation import Segmenter


class IGlobal(IGlobalBase):
    segmenter = None
    device_lock = None

    def beginGlobal(self):
        """Build the shared Segmenter facade from the resolved config.

        The selected preset pins its mode, model and revision; the resolver has
        already bounded threshold and maxEdge to the schema's ranges.
        """
        config = self.config

        self.segmenter = Segmenter(
            mode=config.mode,
            model_name=config.model,
            device=None,
            threshold=config.threshold,
            max_edge=config.maxEdge,
            revision=config.revision,
        )

        # Local inference must serialize GPU access
        self.device_lock = make_device_lock()

    def endGlobal(self):
        """Disconnect the facade and release shared state on teardown."""
        if self.segmenter is not None:
            try:
                self.segmenter.disconnect()
            except Exception as exc:
                warning(f'detect_segment: error during teardown, ignoring: {exc}')
        self.segmenter = None
        self.device_lock = None
