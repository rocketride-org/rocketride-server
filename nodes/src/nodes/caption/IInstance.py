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

from rocketlib import IInstanceBase, AVI_ACTION
from ai.common.image import ImageProcessor
from .IGlobal import IGlobal


class IInstance(IInstanceBase):
    """
    IInstance handles per-frame captioning for the caption node.

    Accepts image lane (AVI stream). Emits per frame:
      - text lane: caption string.

    Inference is delegated to the Captioner facade (ai.common.models.vision.caption),
    which runs on the model server when --modelserver is set, else locally.
    """

    IGlobal: IGlobal

    def __init__(self, *args, **kwargs):
        """Initialize per-instance image-accumulation state."""
        super().__init__(*args, **kwargs)
        self._image_data = None

    def _caption(self, image) -> str:
        """Caption one decoded image under the node's device lock.

        Args:
            image: Decoded input PIL image for this frame.

        Returns:
            The caption string.
        """
        with self.IGlobal.device_lock:
            return self.IGlobal.captioner.caption(image)

    def writeImage(self, action: int, mimeType: str, buffer: bytes):
        """Accumulate an inbound image stream and caption it on END.

        Args:
            action: AVI stream action (BEGIN/WRITE/END).
            mimeType: MIME type of the image chunk.
            buffer: Raw bytes for a WRITE action.

        Returns:
            preventDefault() on END to suppress default forwarding; None otherwise.
        """
        if action == AVI_ACTION.BEGIN:
            self._image_data = bytearray()
        elif action == AVI_ACTION.WRITE:
            self._image_data += buffer
        elif action == AVI_ACTION.END:
            try:
                listening = self.instance.hasListener('text')
                try:
                    image = ImageProcessor.load_image_from_bytes(self._image_data)
                    caption_text = self._caption(image) if listening else None
                except Exception as e:
                    # The engine reports only str() of this error, not its
                    # __cause__, so the message carries the cause itself.
                    raise RuntimeError(f'caption: could not caption the image ({type(e).__name__}: {e})') from e
                # Outside the try: a downstream write error is not a caption failure.
                if listening:
                    self.instance.writeText(caption_text)
            finally:
                self._image_data = None
            return self.preventDefault()
