# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

import json
from rocketlib import IInstanceBase, AVI_ACTION, debug, warning
from ai.common.schema import Doc, DocMetadata
from ai.common.image import ImageProcessor
from .IGlobal import IGlobal

SUPPORTED_VIDEO_TYPES = {
    'video/mp4': '.mp4',
    'video/x-msvideo': '.avi',
    'video/quicktime': '.mov',
    'video/webm': '.webm',
}


class IInstance(IInstanceBase):
    """
    IInstance handles per-frame detection for the detect node.

    Accepts images via the image lane (AVI stream) and video files via
    the video lane. Emits an annotated image doc and a JSON text doc
    per frame - identical output contract to detect_segment.
    """

    IGlobal: IGlobal

    def __init__(self, *args, **kwargs):
        """Initialize instance state."""
        super().__init__(*args, **kwargs)
        self._chunk_id = 0
        self._image_data = None
        self._video_data = None
        self._mime_type = None

    def _annotate(self, image, detections):
        """Draw bounding boxes and labels onto a copy of the image."""
        from PIL import ImageDraw

        annotated = image.copy()
        draw = ImageDraw.Draw(annotated)
        for det in detections:
            b = det['box']
            draw.rectangle([b['x1'], b['y1'], b['x2'], b['y2']], outline='lime', width=2)
            draw.text((b['x1'], b['y1'] - 10), f'{det["label"]} {det["score"]:.2f}', fill='lime')
        return annotated

    def _emit(self, image, detections, chunk_id, time_stamp=None, frame_number=None):
        """Emit annotated image doc + JSON text for one frame."""
        annotated = self._annotate(image, detections)
        image_str = ImageProcessor.get_base64(annotated)

        metadata = DocMetadata(
            self,
            chunkId=chunk_id,
            isTable=False,
            tableId=0,
            isDeleted=False,
        )
        metadata.detections = detections
        metadata.detection_model = self.IGlobal.detector.model_name
        metadata.detection_prompt = self.IGlobal.detector.prompt
        if time_stamp is not None:
            metadata.time_stamp = time_stamp
        if frame_number is not None:
            metadata.frame_number = frame_number

        if self.instance.hasListener('documents'):
            self.instance.writeDocuments([Doc(type='Image', page_content=image_str, metadata=metadata)])

        if self.instance.hasListener('text'):
            self.instance.writeText(json.dumps(detections))

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

            with self.IGlobal.device_lock:
                detections = self.IGlobal.detector.detect(image)

            self._emit(image, detections, self._chunk_id)

            self._image_data = None
            self._chunk_id += 1
            return self.preventDefault()

    # -------------------------------------------------------------------------
    # video lane: raw video file
    # -------------------------------------------------------------------------

    def writeVideo(self, action: int, mimeType: str, buffer: bytes):
        if action == AVI_ACTION.BEGIN:
            self._video_data = bytearray()
            self._mime_type = mimeType

        elif action == AVI_ACTION.WRITE:
            if self._video_data is not None:
                max_size = self.IGlobal.max_video_size_bytes
                if len(self._video_data) + len(buffer) > max_size:
                    max_mb = max_size / (1024 * 1024)
                    warning(f'detect: video exceeds {max_mb:.0f} MB limit, rejecting')
                    self._video_data = None
                    return
                self._video_data += buffer

        elif action == AVI_ACTION.END:
            video_data = self._video_data
            self._video_data = None
            if video_data is not None and len(video_data) > 0:
                self._process_video(bytes(video_data))
            elif video_data is None:
                warning('detect: video rejected (size limit exceeded), skipping')

    def _process_video(self, video_bytes: bytes):
        from ai.common.opencv import cv2
        import tempfile
        import os

        suffix = SUPPORTED_VIDEO_TYPES.get(self._mime_type, '.mp4')
        tmp_fd, tmp_path = tempfile.mkstemp(suffix=suffix)
        try:
            with os.fdopen(tmp_fd, 'wb') as f:
                f.write(video_bytes)

            cap = cv2.VideoCapture(tmp_path)
            try:
                if not cap.isOpened():
                    warning('detect: failed to open video file')
                    return

                fps = cap.get(cv2.CAP_PROP_FPS)
                if fps <= 0:
                    fps = 30.0

                total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
                interval = self.IGlobal.interval
                max_frames = self.IGlobal.max_frames
                frame_interval_frames = max(1, int(interval * fps))

                frames_extracted = 0
                current_frame_pos = 0
                last_read_pos = -2

                while True:
                    if max_frames > 0 and frames_extracted >= max_frames:
                        break
                    if current_frame_pos >= total_frames:
                        break

                    if current_frame_pos != last_read_pos + 1:
                        cap.set(cv2.CAP_PROP_POS_FRAMES, current_frame_pos)
                    ret, frame = cap.read()
                    if not ret:
                        break
                    last_read_pos = current_frame_pos

                    time_stamp = current_frame_pos / fps

                    _, png_buffer = cv2.imencode('.png', frame)
                    pil_image = ImageProcessor.load_image_from_bytes(png_buffer.tobytes())

                    with self.IGlobal.device_lock:
                        detections = self.IGlobal.detector.detect(pil_image)

                    self._emit(pil_image, detections, self._chunk_id, time_stamp=time_stamp, frame_number=current_frame_pos)

                    self._chunk_id += 1
                    frames_extracted += 1
                    current_frame_pos += frame_interval_frames

                debug(f'detect: processed {frames_extracted} frames at {interval}s intervals')
            finally:
                cap.release()
        finally:
            if os.path.exists(tmp_path):
                os.unlink(tmp_path)
