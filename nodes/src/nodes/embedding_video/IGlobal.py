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
    IGlobal manages global lifecycle events for the video embedding node.

    It handles setup of the embedding model, frame extraction configuration,
    and shared resources at the start of the node's global lifecycle, and
    ensures proper cleanup when the lifecycle ends.
    """

    def beginGlobal(self):
        """
        Initialize resources needed for the video embedding node.

        This includes:
        - Installing node-specific dependencies from requirements.txt.
        - Importing and loading the embedding model for frame embedding.
        - Loading frame extraction configuration (interval, max frames, etc.).
        - Creating a thread lock for device access during video processing.
        """
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return

        from depends import depends

        requirements = os.path.join(os.path.dirname(os.path.realpath(__file__)), 'requirements.txt')
        depends(requirements)

        # Import torch to ensure the PyTorch framework is loaded.
        import ai.common.torch  # noqa: F401

        # Import Embedding class locally to avoid circular imports.
        from nodes.embedding_image.embedding import Embedding

        # Access the 'bag' from the current endpoint.
        bag = self.IEndpoint.endpoint.bag

        # Retrieve node-specific configuration.
        config = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)

        # Instantiate the Embedding object for generating frame embeddings.
        # Pass raw connConfig since Embedding calls getNodeConfig internally.
        self.embedding = Embedding(self.glb.logicalType, self.glb.connConfig, bag)

        # Store frame extraction settings from the config.
        self.frame_interval = config.get('interval', 5)
        self.max_frames = config.get('max_frames', 50)
        self.start_time = config.get('start_time', 0)
        self.duration = config.get('duration', 0)
        self.max_video_size_bytes = config.get('maxVideoSizeMB', 500) * 1024 * 1024

        # Mutex for device access during video processing.
        self.device_lock = threading.Lock()

    def endGlobal(self):
        """
        Clean up resources when the global lifecycle ends.

        Releases the embedding model reference and device lock to allow
        garbage collection of resources.
        """
        self.embedding = None
        self.device_lock = None
