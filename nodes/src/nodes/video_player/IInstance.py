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

import os
import tempfile
import mimetypes
from rocketlib import IInstanceBase, AVI_ACTION, Entry, debug
from .IGlobal import IGlobal
from .srt import build_srt


class IInstance(IInstanceBase):
    """
    Sink node that plays a video with optional synchronized subtitles.

    Inputs:
      - video:     encoded video stream (written as-is to a temp file)
      - documents: timed subtitle segments (Doc objects with time_stamp [and time_stamp_end])
      - text:      plain subtitle text (displayed as a single cue if no documents present)

    On close, writes the collected subtitles to an SRT file and hands both
    temp files to the VideoPlayer, which uses ffpyplayer + ffmpeg's `subtitles`
    filter to render video+audio+burned-in subtitles.
    """

    IGlobal: IGlobal

    _video_path: str = None
    _video_file = None
    _srt_path: str = None
    _docs: list = None
    _text_fallback: str = ''

    def beginInstance(self):
        """
        Initialize per-instance state.

        Called once when the instance is constructed, before any streams.

        Returns:
            None.
        """
        self._video_path = None
        self._video_file = None
        self._srt_path = None
        self._docs = []
        self._text_fallback = ''

    def _suffix_for_mime(self, mime_type: str) -> str:
        """
        Pick a temp-file suffix from the declared MIME type.

        Args:
            mime_type (str): MIME type declared on the video lane (e.g. 'video/mp4').

        Returns:
            str: File extension including the leading dot (falls back to '.mp4').
        """
        if mime_type:
            ext = mimetypes.guess_extension(mime_type)
            if ext:
                return ext
        return '.mp4'

    def _ensure_video_file(self, mime_type: str):
        """
        Open the temp video file on first write, choosing a suffix that matches
        the incoming MIME type so ffmpeg can probe the container correctly.

        Args:
            mime_type (str): MIME type of the current video lane payload.

        Returns:
            None.
        """
        if self._video_file is None:
            suffix = self._suffix_for_mime(mime_type)
            fd, path = tempfile.mkstemp(prefix='rr_video_', suffix=suffix)
            self._video_file = os.fdopen(fd, 'wb')
            self._video_path = path

    def open(self, object: Entry):
        """
        Reset per-stream subtitle accumulators when a new entry arrives.

        Args:
            object (Entry): The entry object beginning processing.

        Returns:
            None.
        """
        # New stream — reset accumulators
        self._docs = []
        self._text_fallback = ''

    def writeVideo(self, action: AVI_ACTION, mimeType: str, buffer: bytes):
        """
        Receive a chunk of the encoded video stream and append it to the temp file.

        Args:
            action (AVI_ACTION): Stream action marker (BEGIN, WRITE, or END).
            mimeType (str): MIME type of the stream (e.g. 'video/mp4').
            buffer (bytes): Encoded video payload for this chunk. May be empty.

        Returns:
            None.
        """
        if action == AVI_ACTION.BEGIN:
            self._ensure_video_file(mimeType)
        elif action == AVI_ACTION.WRITE:
            if buffer:
                self._ensure_video_file(mimeType)
                self._video_file.write(buffer)
        elif action == AVI_ACTION.END:
            if self._video_file is not None:
                self._video_file.flush()

    def writeDocuments(self, docs):
        """
        Collect timed subtitle segments for later SRT generation.

        Args:
            docs (list[Doc]): Doc objects carrying subtitle text and
                metadata (`time_stamp`, optional `time_stamp_end`).

        Returns:
            None.
        """
        if docs:
            self._docs.extend(docs)

    def writeText(self, text: str):
        """
        Accumulate plain subtitle text as a fallback (no timing info).

        Args:
            text (str): Incoming chunk of plain subtitle text.

        Returns:
            None.
        """
        if text:
            self._text_fallback += text

    def closing(self):
        """
        Finalize inputs and launch playback.

        Closes the video temp file, writes an SRT file from the collected
        subtitle documents (or from the plain-text fallback), then opens the
        video+subtitle pair in a local playback window. Blocks until playback
        completes.

        Returns:
            None.
        """
        # Nothing to play if no video arrived
        if self._video_file is None:
            return

        try:
            self._video_file.close()
        finally:
            self._video_file = None

        # Build SRT if we have any subtitle input
        srt_content = None
        if self._docs:
            srt_content = build_srt(self._docs)
        elif self._text_fallback:
            cue_text = self._text_fallback.strip()
            if cue_text:
                srt_content = f'1\n00:00:00,000 --> 99:59:59,000\n{cue_text}\n'

        if srt_content:
            fd, srt_path = tempfile.mkstemp(prefix='rr_video_', suffix='.srt')
            try:
                with os.fdopen(fd, 'w', encoding='utf-8') as f:
                    f.write(srt_content)
                self._srt_path = srt_path
            except Exception:
                try:
                    os.unlink(srt_path)
                except OSError:
                    pass
                self._srt_path = None

        from .player import VideoPlayer

        try:
            with self.IGlobal.lock:
                VideoPlayer(self._video_path, self._srt_path).play()
        except Exception as e:
            debug(f'video_player playback failed: {e}')

    def endInstance(self):
        """
        Release per-instance resources and delete temp files.

        Called once when the instance is torn down.

        Returns:
            None.
        """
        # Clean up any leftover temp files
        for path in (self._video_path, self._srt_path):
            if path:
                try:
                    os.unlink(path)
                except OSError:
                    pass
        self._video_path = None
        self._srt_path = None
        if self._video_file is not None:
            try:
                self._video_file.close()
            except Exception:
                pass
            self._video_file = None
