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
from rocketlib import IGlobalBase, OPEN_MODE
from ai.common.config import Config


class IGlobal(IGlobalBase):
    """
    Global context for the Object Detection Filter node.

    Loads the detection model and (optionally) the CLIP reference
    embedding once per pipeline execution and shares them across
    all instances.
    """

    detector = None
    config = None

    def beginGlobal(self):
        self.device_lock = threading.Lock()
        self.config = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
        self.config['type'] = self.glb.connConfig.get('profile', 'detr')

        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return

        try:
            from .detector import ObjectDetector

            self.detector = ObjectDetector(self.config)
        except Exception:
            raise

    def endGlobal(self):
        self.detector = None
        self.device_lock = None
