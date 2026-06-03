# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

from rocketlib import IInstanceBase, AVI_ACTION, warning
from ai.common.image import ImageProcessor
from .IGlobal import IGlobal


class IInstance(IInstanceBase):
    """
    IInstance handles per-frame captioning for the caption node.

    Accepts image lane (AVI stream). Emits per frame:
      - text lane: caption string
    """

    IGlobal: IGlobal

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._image_data = None
        self._chunk_id = 0

    def _emit(self, caption_text, chunk_id):
        if self.instance.hasListener('text'):
            self.instance.writeText(caption_text)

    def writeImage(self, action: int, mimeType: str, buffer: bytes):
        if action == AVI_ACTION.BEGIN:
            self._image_data = bytearray()

        elif action == AVI_ACTION.WRITE:
            self._image_data += buffer

        elif action == AVI_ACTION.END:
            try:
                image = ImageProcessor.load_image_from_bytes(self._image_data)
                with self.IGlobal.device_lock:
                    caption_text = self.IGlobal.captioner.caption(image)
            except Exception as e:
                warning(f'caption: inference failed for frame {self._chunk_id}, passing empty: {e}')
                caption_text = ''

            self._emit(caption_text, self._chunk_id)

            self._image_data = None
            self._chunk_id += 1
            return self.preventDefault()
