# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

import json
from rocketlib import IInstanceBase, AVI_ACTION, warning
from ai.common.schema import Doc, DocMetadata
from ai.common.image import ImageProcessor
from .IGlobal import IGlobal


class IInstance(IInstanceBase):
    """
    IInstance handles image processing for the describe node.

    Accepts images via the image or documents lane. Always emits to both:
    - text lane: task result (caption string, JSON boxes, OCR text)
    - documents lane: annotated image for visual tasks, original for text tasks
    """

    IGlobal: IGlobal

    def __init__(self, *args, **kwargs):
        """Initialize instance state."""
        super().__init__(*args, **kwargs)
        self._image_data = None
        self._chunk_id = 0

    def _annotate(self, image, result_text):
        """
        Draw boxes on image if the result contains bounding box data.
        Returns the annotated image (or original if no boxes to draw).
        """
        from PIL import ImageDraw

        try:
            data = json.loads(result_text)
        except (json.JSONDecodeError, TypeError):
            return image

        annotated = image.copy()
        draw = ImageDraw.Draw(annotated)

        # Standard boxes: OD, grounding, dense regions → {"bboxes": [...], "labels": [...]}
        if isinstance(data, dict) and 'bboxes' in data:
            boxes = data.get('bboxes', [])
            labels = data.get('labels', [])
            for i, box in enumerate(boxes):
                if len(box) >= 4:
                    x1, y1, x2, y2 = box[:4]
                    draw.rectangle([x1, y1, x2, y2], outline='dodgerblue', width=2)
                    label = labels[i] if i < len(labels) else ''
                    if label:
                        draw.text((x1, max(0, y1 - 10)), label[:40], fill='dodgerblue')
            return annotated

        # Quad boxes: OCR with regions → {"quad_boxes": [...], "labels": [...]}
        if isinstance(data, dict) and 'quad_boxes' in data:
            boxes = data.get('quad_boxes', [])
            labels = data.get('labels', [])
            for i, box in enumerate(boxes):
                if len(box) >= 8:
                    pts = [(box[j], box[j + 1]) for j in range(0, 8, 2)]
                    draw.polygon(pts, outline='dodgerblue')
                    label = labels[i] if i < len(labels) else ''
                    if label:
                        draw.text((box[0], max(0, box[1] - 10)), label[:40], fill='dodgerblue')
            return annotated

        return image

    def _emit(self, image, result_text, chunk_id):
        """Emit text result + annotated (or original) image doc."""
        annotated = self._annotate(image, result_text)
        image_str = ImageProcessor.get_base64(annotated)

        metadata = DocMetadata(
            self,
            chunkId=chunk_id,
            isTable=False,
            tableId=0,
            isDeleted=False,
        )
        metadata.describe_task = self.IGlobal.describer.task_key
        metadata.describe_model = self.IGlobal.describer.model_name
        metadata.annotated = annotated is not image  # True if boxes were drawn, False if original passed through

        if self.instance.hasListener('text'):
            self.instance.writeText(result_text)

        if self.instance.hasListener('documents'):
            self.instance.writeDocuments([Doc(type='Image', page_content=image_str, metadata=metadata)])

        if self.instance.hasListener('image'):
            image_bytes = ImageProcessor.get_bytes(annotated)
            self.instance.writeImage(AVI_ACTION.BEGIN, 'image/png')
            self.instance.writeImage(AVI_ACTION.WRITE, 'image/png', image_bytes)
            self.instance.writeImage(AVI_ACTION.END, 'image/png')

    # -------------------------------------------------------------------------
    # image lane: AVI stream
    # -------------------------------------------------------------------------

    def writeImage(self, action: int, mimeType: str, buffer: bytes):
        if action == AVI_ACTION.BEGIN:
            self._image_data = bytearray()

        elif action == AVI_ACTION.WRITE:
            self._image_data += buffer

        elif action == AVI_ACTION.END:
            image = ImageProcessor.load_image_from_bytes(self._image_data)

            try:
                with self.IGlobal.device_lock:
                    result = self.IGlobal.describer.describe(image)
            except Exception as e:
                warning(f'describe: inference failed for frame {self._chunk_id}, passing original: {e}')
                result = ''

            self._emit(image, result, self._chunk_id)

            self._image_data = None
            self._chunk_id += 1
            return self.preventDefault()

    # -------------------------------------------------------------------------
    # documents lane: image documents (e.g. from frame_grabber)
    # -------------------------------------------------------------------------

    def writeDocuments(self, documents: list[Doc]):
        for doc in documents:
            if doc.type != 'Image':
                warning(f'describe: skipping document with unexpected type "{doc.type}"')
                continue
            if not doc.page_content:
                warning('describe: skipping Image document with empty content')
                continue

            image = ImageProcessor.load_image_from_base64(doc.page_content)

            try:
                with self.IGlobal.device_lock:
                    result = self.IGlobal.describer.describe(image)
            except Exception as e:
                warning(f'describe: inference failed for frame {self._chunk_id}, passing original: {e}')
                result = ''

            self._emit(image, result, self._chunk_id)
            self._chunk_id += 1

        return self.preventDefault()
