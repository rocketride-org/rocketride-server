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
    IInstance handles depth estimation for the depth_estimate node.

    Accepts images (AVI stream), image documents, and video files.
    Emits a colorized depth map on the documents lane and depth stats
    (min, max, mean) as JSON on the text lane.
    """

    IGlobal: IGlobal

    def __init__(self, *args, **kwargs):
        """Initialize instance state."""
        super().__init__(*args, **kwargs)
        self._chunk_id = 0
        self._image_data = None
        self._video_data = None
        self._mime_type = None

    def _emit(self, image, chunk_id, time_stamp=None, frame_number=None):
        with self.IGlobal.device_lock:
            depth_image, stats = self.IGlobal.estimator.estimate(image)

        image_str = ImageProcessor.get_base64(depth_image)

        metadata = DocMetadata(
            self,
            chunkId=chunk_id,
            isTable=False,
            tableId=0,
            isDeleted=False,
        )
        metadata.depth_model = self.IGlobal.estimator.model_name
        metadata.depth_min = stats['min']
        metadata.depth_max = stats['max']
        metadata.depth_mean = stats['mean']
        if time_stamp is not None:
            metadata.time_stamp = time_stamp
        if frame_number is not None:
            metadata.frame_number = frame_number

        if self.instance.hasListener('documents'):
            self.instance.writeDocuments([Doc(type='Image', page_content=image_str, metadata=metadata)])

        if self.instance.hasListener('text'):
            self.instance.writeText(json.dumps(stats))

        if self.instance.hasListener('image'):
            image_bytes = ImageProcessor.get_bytes(depth_image)
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
            self._emit(image, self._chunk_id)
            self._image_data = None
            self._chunk_id += 1
            return self.preventDefault()

    # -------------------------------------------------------------------------
    # documents lane: image documents (e.g. from frame_grabber)
    # -------------------------------------------------------------------------

    def writeDocuments(self, documents: list[Doc]):
        for doc in documents:
            if doc.type != 'Image':
                warning(f'depth_estimate: skipping unexpected doc type "{doc.type}"')
                continue
            image = ImageProcessor.load_image_from_base64(doc.page_content)
            self._emit(image, self._chunk_id)
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
                    warning(f'depth_estimate: video exceeds {max_size / 1024 / 1024:.0f} MB limit, rejecting')
                    self._video_data = None
                    return
                self._video_data += buffer
        elif action == AVI_ACTION.END:
            video_data = self._video_data
            self._video_data = None
            if video_data is not None and len(video_data) > 0:
                self._process_video(bytes(video_data))
            elif video_data is None:
                warning('depth_estimate: video rejected (size limit exceeded), skipping')

    def _process_video(self, video_bytes: bytes):
        from ai.common.opencv import cv2
        import os
        import tempfile

        suffix = SUPPORTED_VIDEO_TYPES.get(self._mime_type, '.mp4')
        tmp_fd, tmp_path = tempfile.mkstemp(suffix=suffix)
        try:
            with os.fdopen(tmp_fd, 'wb') as f:
                f.write(video_bytes)

            cap = cv2.VideoCapture(tmp_path)
            try:
                if not cap.isOpened():
                    warning('depth_estimate: failed to open video file')
                    return

                fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
                total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
                frame_interval = max(1, int(self.IGlobal.interval * fps))
                current_pos = 0
                last_read = -2
                frames_done = 0

                while current_pos < total_frames:
                    if current_pos != last_read + 1:
                        cap.set(cv2.CAP_PROP_POS_FRAMES, current_pos)
                    ret, frame = cap.read()
                    if not ret:
                        break
                    last_read = current_pos

                    _, png_buf = cv2.imencode('.png', frame)
                    pil_image = ImageProcessor.load_image_from_bytes(png_buf.tobytes())
                    self._emit(pil_image, self._chunk_id, time_stamp=current_pos / fps, frame_number=current_pos)
                    self._chunk_id += 1
                    frames_done += 1
                    current_pos += frame_interval

                debug(f'depth_estimate: processed {frames_done} frames')
            finally:
                cap.release()
        finally:
            if os.path.exists(tmp_path):
                os.unlink(tmp_path)
