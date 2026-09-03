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

from rocketlib import IInstanceBase, AVI_ACTION, warning
from .IGlobal import IGlobal


class IInstance(IInstanceBase):
    """
    IInstance handles per-frame image description for the Describe (caption) node.

    Accepts image lane (AVI stream). Emits per frame:
      - text lane: description string.

    Inference is delegated to the Captioner facade (ai.common.models.vision.caption),
    which runs on the model server when --modelserver is set, else locally.
    """

    IGlobal: IGlobal

    def __init__(self, *args, **kwargs):
        """Initialize per-instance image-accumulation state."""
        super().__init__(*args, **kwargs)
        self._image_data = None

    def _emit(self, image):
        """Describe one image and write the result to the text lane.

        Args:
            image: Encoded image bytes for this frame.
        """
        if self.instance.hasListener('text'):
            with self.IGlobal.device_lock:
                caption_text = self.IGlobal.captioner.caption(
                    image,
                    prompt=self.IGlobal.prompt,
                    max_new_tokens=self.IGlobal.max_new_tokens,
                )
            self.instance.writeText(caption_text)

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
                # Hand the encoded bytes straight to the facade: it decodes only
                # when a downscale is needed and otherwise transports the
                # original (smaller) encoding; decode errors still land in this
                # except block either way.
                self._emit(bytes(self._image_data))
            except Exception as e:
                warning(f'caption: inference failed, passing empty: {e}')
                if self.instance.hasListener('text'):
                    self.instance.writeText('')
            self._image_data = None
            return self.preventDefault()
