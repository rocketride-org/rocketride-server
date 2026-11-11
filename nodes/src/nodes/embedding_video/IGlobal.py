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

from rocketlib import IGlobalBase
from ai.common.models.base import make_device_lock

from nodes.embedding_image.embedding import Embedding


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
        - Loading the embedding model the selected profile pins (or the custom
          profile names) for frame embedding.
        - Reading the frame extraction settings (interval, max frames, etc.)
          from the resolved config, which already applied the defaults.
        - Creating the device guard for frame embedding: a lock in-process, a no-op
          with --modelserver.

        Note:
            Nothing here loads or installs torch -- see
            embedding_image.IGlobal.beginGlobal.
        """
        config = self.config

        # Instantiate the Embedding object for generating frame embeddings.
        self.embedding = Embedding(config.model)

        # Store frame extraction settings from the config.
        self.frame_interval = config.interval
        self.max_frames = config.max_frames
        self.start_time = config.start_time
        self.duration = config.duration
        self.max_video_size_bytes = config.maxVideoSizeMB * 1024 * 1024

        # Local inference must serialize GPU access; with --modelserver this is a
        # no-op so concurrent videos' frame requests reach the model server's
        # workers instead of queueing here one frame at a time (the frames of one
        # video are embedded in order either way).
        self.device_lock = make_device_lock()

    def endGlobal(self):
        """
        Clean up resources when the global lifecycle ends.

        Releases the embedding model reference and device lock to allow
        garbage collection of resources.
        """
        self.embedding = None
        self.device_lock = None
