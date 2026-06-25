# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

import json

from rocketlib import IInstanceBase, AVI_ACTION, warning
from ai.common.image import ImageProcessor

from .IGlobal import IGlobal


class IInstance(IInstanceBase):
    """
    IInstance for the Face Detection node.

    Accepts image lane (AVI stream). Emits per frame:
      - text lane: JSON array of face detections
      - image lane: annotated frame with boxes + optional landmark dots
    """

    IGlobal: IGlobal

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._chunk_id = 0
        self._image_data = None

    def _annotate(self, image, faces):
        """Draw bounding boxes and optional landmark dots onto a copy."""
        from PIL import ImageDraw

        annotated = image.copy()
        draw = ImageDraw.Draw(annotated)

        for face in faces:
            b = face['box']
            draw.rectangle(
                [b['x1'], b['y1'], b['x2'], b['y2']],
                outline='cyan',
                width=2,
            )
            label_text = f'{face["label"]} {face["score"]:.2f}'
            draw.text((b['x1'], b['y1'] - 10), label_text, fill='cyan')

            for kp in face.get('landmarks', []) or []:
                x, y = kp['x'], kp['y']
                r = 2
                draw.ellipse([x - r, y - r, x + r, y + r], outline='cyan', fill='cyan')

        return annotated

    def _emit(self, image, faces, chunk_id):
        annotated = self._annotate(image, faces)

        if self.instance.hasListener('text'):
            self.instance.writeText(json.dumps(faces))

        if self.instance.hasListener('image'):
            image_bytes = ImageProcessor.get_bytes(annotated, fmt='JPEG')
            self.instance.writeImage(AVI_ACTION.BEGIN, 'image/jpeg')
            self.instance.writeImage(AVI_ACTION.WRITE, 'image/jpeg', image_bytes)
            self.instance.writeImage(AVI_ACTION.END, 'image/jpeg')

    def writeImage(self, action: int, mimeType: str, buffer: bytes):
        if action == AVI_ACTION.BEGIN:
            self._image_data = bytearray()

        elif action == AVI_ACTION.WRITE:
            self._image_data += buffer

        elif action == AVI_ACTION.END:
            try:
                image = ImageProcessor.load_image_from_bytes(self._image_data)
                with self.IGlobal.device_lock:
                    faces = self.IGlobal.detector.detect(image)
                self._emit(image, faces, self._chunk_id)
            except Exception as exc:
                warning(f'face_detection: dropped frame {self._chunk_id}: {exc}')
            finally:
                self._image_data = None
                self._chunk_id += 1
            return self.preventDefault()
