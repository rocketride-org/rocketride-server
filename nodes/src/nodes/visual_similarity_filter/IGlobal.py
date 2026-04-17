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
    Global context for the Visual Similarity Filter node.

    Loads the DINOv2 embedder once per pipeline execution and shares it across
    all instances via a thread lock.

    Scoring strategy:
      - Patch-level matching (DINOv2): compare reference car patch tokens to frame
        patch tokens. score = mean(top-K cosine matches across 196 patches).
        Works for ANY car — just send the reference image for that car.
      - Cosine fallback (non-DINOv2 models): max cosine over multi-crop embeddings.

    The reference image arrives on the image lane (by filename pattern) and is
    required to start scoring.
    """

    embedder = None
    config = None
    reference_embeddings = None  # list of global crop embeddings (cosine fallback)
    reference_patches = None  # np.ndarray [N_patches, D] for DINOv2 patch matching
    reference_ready = None

    def beginGlobal(self):
        self.device_lock = threading.Lock()
        self.reference_ready = threading.Event()
        self.config = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
        self.config['type'] = self.glb.connConfig.get('profile', 'dinov2-base')

        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return

        from .embedder import FrameEmbedder

        self.embedder = FrameEmbedder(self.config)

    def endGlobal(self):
        self.embedder = None
        self.reference_embeddings = None
        self.reference_patches = None
        self.reference_ready = None
        self.device_lock = None
