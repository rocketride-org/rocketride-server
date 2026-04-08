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

from rocketlib import IInstanceBase, AVI_ACTION, debug, warning
from ai.common.schema import Doc, DocMetadata
from .IGlobal import IGlobal

# Supported video MIME types and their corresponding file extensions.
SUPPORTED_VIDEO_TYPES = {
    'video/mp4': '.mp4',
    'video/x-msvideo': '.avi',
    'video/quicktime': '.mov',
    'video/webm': '.webm',
}


class IInstance(IInstanceBase):
    """
    IInstance manages instance-level processing of video data for embedding.

    It receives video data via the writeVideo streaming interface, extracts
    frames at configurable intervals using OpenCV, generates embeddings for
    each frame using the global embedding model, and outputs documents with
    embedding vectors and timestamp metadata.
    """

    IGlobal: IGlobal
    """
    Reference to the global context object of type IGlobal.

    This provides access to shared resources like the embedding model and
    frame extraction configuration.
    """

    def __init__(self, *args, **kwargs):
        """Initialize the video embedding instance with frame tracking state."""
        super().__init__(*args, **kwargs)
        self._frame_chunk_id = 0
        self._video_data = None
        self._mime_type = None

    def writeVideo(self, action: int, mimeType: str, buffer: bytes):
        """
        Handle streaming video data via the AVI action protocol.

        Video data arrives in chunks through BEGIN/WRITE/END actions. Once
        all data is received, frames are extracted and embedded.

        Args:
            action (int): The AVI action type (BEGIN, WRITE, or END).
            mimeType (str): The MIME type of the video data.
            buffer (bytes): The video data chunk.
        """
        if action == AVI_ACTION.BEGIN:
            self._video_data = bytearray()
            self._mime_type = mimeType

        elif action == AVI_ACTION.WRITE:
            if self._video_data is not None:
                max_size = self.IGlobal.max_video_size_bytes
                if len(self._video_data) + len(buffer) > max_size:
                    max_mb = max_size / (1024 * 1024)
                    warning(f'Video exceeds maximum allowed size of {max_mb:.0f} MB, rejecting')
                    self._video_data = None
                    return
                self._video_data += buffer

        elif action == AVI_ACTION.END:
            video_data = self._video_data
            self._video_data = None
            if video_data is not None and len(video_data) > 0:
                self._process_video(bytes(video_data))
            elif video_data is None:
                warning('Video was rejected (size limit exceeded or missing BEGIN), skipping embedding')

    def _process_video(self, video_bytes: bytes):
        """
        Extract frames from video bytes and generate embeddings for each frame.

        Uses OpenCV to decode the video from an in-memory buffer, extracts
        frames at the configured interval, and creates embedding documents
        for each extracted frame.

        Args:
            video_bytes (bytes): The complete video file content.
        """
        from ai.common.opencv import cv2
        from ai.common.image import ImageProcessor
        import tempfile
        import os

        # Write video bytes to a temporary file for OpenCV to read.
        # OpenCV's VideoCapture requires a file path or device index.
        suffix = SUPPORTED_VIDEO_TYPES.get(self._mime_type, '.mp4')
        tmp_fd, tmp_path = tempfile.mkstemp(suffix=suffix)
        try:
            with os.fdopen(tmp_fd, 'wb') as f:
                f.write(video_bytes)

            cap = cv2.VideoCapture(tmp_path)
            try:
                if not cap.isOpened():
                    warning('Failed to open video file for frame extraction')
                    return

                fps = cap.get(cv2.CAP_PROP_FPS)
                if fps <= 0:
                    fps = 30.0  # Fallback to a reasonable default

                total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
                video_duration = total_frames / fps

                # Determine extraction boundaries.
                start_time = self.IGlobal.start_time
                duration = self.IGlobal.duration
                if duration <= 0:
                    end_time = video_duration
                else:
                    end_time = min(start_time + duration, video_duration)

                interval = self.IGlobal.frame_interval
                max_frames = self.IGlobal.max_frames

                # Seek to start position if needed.
                if start_time > 0:
                    start_frame = int(start_time * fps)
                    cap.set(cv2.CAP_PROP_POS_FRAMES, start_frame)

                frames_extracted = 0
                frame_interval_frames = max(1, int(interval * fps))
                documents = []

                current_frame_pos = int(start_time * fps) if start_time > 0 else 0

                while True:
                    # Check max frames limit.
                    if max_frames > 0 and frames_extracted >= max_frames:
                        break

                    # Check if we've gone past end time.
                    current_time = current_frame_pos / fps
                    if current_time >= end_time:
                        break

                    # Set position and read the frame.
                    cap.set(cv2.CAP_PROP_POS_FRAMES, current_frame_pos)
                    ret, frame = cap.read()
                    if not ret:
                        break

                    # Calculate the timestamp for this frame.
                    time_stamp = current_frame_pos / fps

                    # Convert BGR frame to PNG bytes, then load as PIL Image via ImageProcessor.
                    _, png_buffer = cv2.imencode('.png', frame)
                    frame_bytes = png_buffer.tobytes()
                    pil_image = ImageProcessor.load_image_from_bytes(frame_bytes)

                    # Generate the embedding with device lock for thread safety.
                    with self.IGlobal.device_lock:
                        embedding = self.IGlobal.embedding.create_image_embedding(pil_image)

                    # Encode the frame as base64 for document storage.
                    frame_base64 = ImageProcessor.get_base64(pil_image)

                    # Create metadata with frame number and timestamp.
                    metadata = DocMetadata(
                        self,
                        chunkId=self._frame_chunk_id,
                        isTable=False,
                        tableId=0,
                        isDeleted=False,
                    )
                    metadata.time_stamp = time_stamp
                    metadata.frame_number = current_frame_pos

                    # Create the document with the frame image and embedding.
                    doc = Doc(type='Image', page_content=frame_base64, metadata=metadata)
                    doc.embedding = embedding if isinstance(embedding, list) else embedding.tolist()
                    doc.embedding_model = self.IGlobal.embedding.model_name

                    documents.append(doc)

                    self._frame_chunk_id += 1
                    frames_extracted += 1

                    # Advance to the next frame position.
                    current_frame_pos += frame_interval_frames

                # Emit all frame documents in a single call.
                if documents:
                    self.instance.writeDocuments(documents)

                debug(f'Video embedding complete: extracted {frames_extracted} frames, interval={interval:.1f}s')
            finally:
                cap.release()

        finally:
            # Clean up the temporary file.
            if os.path.exists(tmp_path):
                os.unlink(tmp_path)
