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

import os
import threading
from rocketlib import IGlobalBase, OPEN_MODE
from ai.common.config import Config


class IGlobal(IGlobalBase):
    """
    IGlobal manages global lifecycle for the detect_segment node.

    Loads SAM3 once at pipeline start and provides a device lock
    for thread-safe inference across IInstance handlers.
    """

    def beginGlobal(self):
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return

        # TODO: detect_segment is not yet functional. Four blockers:
        # 1. SAM3 must be installed from GitHub (not PyPI):
        #      git clone https://github.com/facebookresearch/sam3.git && cd sam3 && pip install -e .
        # 2. Model server Dockerfile must be upgraded: CUDA 12.1 → 12.6+, torch 2.3 → 2.10
        # 3. HF_TOKEN env var must be set with approved access to facebook/sam3.1
        # 4. DetectionLoader must be registered in rocketride-saas/model_manager.py
        raise NotImplementedError('detect_segment is not yet functional. Blockers: (1) Install SAM3 from GitHub — see node description. (2) Upgrade model server to CUDA 12.6+ / PyTorch 2.10. (3) Set HF_TOKEN with facebook/sam3.1 access. (4) Register DetectionLoader in model_manager.py.')

        from depends import depends

        requirements = os.path.join(os.path.dirname(os.path.realpath(__file__)), 'requirements.txt')
        depends(requirements)

        import ai.common.torch  # noqa: F401

        from .detect_segment import Detector

        bag = self.IEndpoint.endpoint.bag
        config = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)

        self.detector = Detector(self.glb.logicalType, self.glb.connConfig, bag)

        self.interval = config.get('interval', 1)
        self.max_frames = config.get('max_frames', 0)
        self.max_video_size_bytes = config.get('maxVideoSizeMB', 500) * 1024 * 1024
        self.device_lock = threading.Lock()

    def endGlobal(self):
        self.detector = None
        self.device_lock = None
