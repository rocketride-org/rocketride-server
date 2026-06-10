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

from rocketlib import IGlobalBase, debug, OPEN_MODE
from ai.common.config import Config


class IGlobal(IGlobalBase):
    """
    Global context for Anomaly Detector node.

    Initializes the anomaly detector once per pipeline execution and shares
    it across all instances.
    """

    detector = None

    def beginGlobal(self):
        """Initialize the anomaly detector when the pipeline starts."""
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            pass
        else:
            from .detector import AnomalyDetector

            config = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)

            method = config.get('method', 'z_score')
            debug(f'    Loading anomaly detector: method={method}')
            self.detector = AnomalyDetector(config)
            debug('    Anomaly detector initialized')

    def endGlobal(self):
        """Clean up the anomaly detector when the pipeline ends."""
        self.detector = None
