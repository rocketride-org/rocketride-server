# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Cloud STT node instance: buffers a streamed audio/video clip, transcribes it
once at END, and writes the result on the text lane.

Unlike audio_transcribe (local Whisper, chunked in real time as audio arrives),
cloud vendors take one request per clip, so BEGIN/WRITE/END here means "start
buffering / append bytes / send the complete buffer" rather than incremental
processing. The BEGIN payload is the stream *descriptor* (a small JSON document
describing the stream, not media bytes -- see ai.common.avi.descriptor), which
is parsed and discarded; only WRITE/END payloads carry real audio bytes.
"""

from rocketlib import IInstanceBase, AVI_ACTION, Entry, warning
from ai.common.avi.descriptor import descriptor_from_payload

from .IGlobal import IGlobal

# Hard cap on one buffered clip. Cloud vendors take one request per clip (see
# module docstring), so nothing here is chunked the way audio_transcribe's
# local processing is -- an unbounded WRITE stream would grow this buffer
# without limit, and briefly double it again at END's `bytes(self._buffer)`
# copy. 200MB is generous for real dictation/call-length audio (multiple
# hours of compressed audio) while still bounding worst-case memory per
# stream instead of trusting the sender.
_MAX_BUFFER_BYTES = 200 * 1024 * 1024


class IInstance(IInstanceBase):
    """Buffers one audio/video clip across BEGIN/WRITE/END and transcribes it
    via the vendor IGlobal resolves, writing the result on the text lane.
    """

    IGlobal: IGlobal

    def open(self, object: Entry):
        """New stream: reset the buffer and descriptor."""
        self._buffer = bytearray()
        self._mime_type = ''
        self._descriptor = None

    def _consume_media(self, action: int, mimeType: str, buffer: bytes):
        """Route one BEGIN/WRITE/END step of an audio or video stream.

        BEGIN parses and discards the stream descriptor (see the module
        docstring) and resets the buffer. WRITE appends bytes, enforcing
        ``_MAX_BUFFER_BYTES``. END sends the complete buffered clip to the
        vendor and writes the resulting transcript.
        """
        if action == AVI_ACTION.BEGIN:
            self._descriptor = descriptor_from_payload(buffer)
            self._buffer = bytearray()
            self._mime_type = mimeType
            return

        if buffer:
            if len(self._buffer) + len(buffer) > _MAX_BUFFER_BYTES:
                self._buffer = bytearray()
                warning(f'Cloud STT: clip exceeded the {_MAX_BUFFER_BYTES}-byte buffer cap; failing this stream')
                raise ValueError(f'Cloud STT: clip exceeds the {_MAX_BUFFER_BYTES}-byte limit')
            self._buffer.extend(buffer)
        if mimeType:
            self._mime_type = mimeType

        if action == AVI_ACTION.END:
            if not self._buffer:
                return
            try:
                text = self.IGlobal.transcribe(bytes(self._buffer), self._mime_type)
            except Exception as e:
                warning(f'Cloud STT transcription failed: {e}')
                raise
            finally:
                self._buffer = bytearray()
            self.instance.writeText(text)

    def writeAudio(self, action: int, mimeType: str, buffer: bytes):
        """Consume one BEGIN/WRITE/END step of an audio stream."""
        self._consume_media(action, mimeType, buffer)

    def writeVideo(self, action: int, mimeType: str, buffer: bytes):
        """Consume one BEGIN/WRITE/END step of a video stream (its audio track, as bytes)."""
        self._consume_media(action, mimeType, buffer)
