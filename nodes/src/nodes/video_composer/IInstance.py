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

# NOTE: Frames are buffered in memory (self._frames). Peak RAM is roughly
# frame_count × frame_size. Acceptable for <500 frames at typical resolutions.
# For larger workloads, revisit with PyAV (Option 2) or object store (Option 3).

import logging
import subprocess

from rocketlib import IInstanceBase, AVI_ACTION, Entry

from .IGlobal import IGlobal

_logger = logging.getLogger(__name__)


def _log(msg: str):
    _logger.debug(msg)


class IInstance(IInstanceBase):
    IGlobal: IGlobal

    # Maps MIME type to the FFmpeg image2pipe input codec name
    _MIME_CODEC = {
        'image/png':  'png',
        'image/jpeg': 'mjpeg',
        'image/jpg':  'mjpeg',
        'image/webp': 'webp',
        'image/bmp':  'bmp',
        'image/tiff': 'tiff',
    }

    def beginInstance(self):
        self._frames: list[bytes] = []
        self._image_buf = bytearray()
        self._image_mime = 'image/png'

        cfg = self.IGlobal.config
        self._fps = cfg.get('fps', 1.0)
        self._codec = cfg.get('codec', 'libx264')
        self._crf = int(cfg.get('crf', 23))

    def endInstance(self):
        self._cleanup()

    def open(self, obj: Entry):
        self._frames = []
        _log('open: in-memory frame buffer initialised')

    def close(self):
        frame_count = len(self._frames)
        _log(f'close: frame_count={frame_count}')
        if frame_count == 0:
            self._cleanup()
            return

        mp4_bytes = self._encode_video()
        if mp4_bytes:
            _log(f'close: encoded ok size={len(mp4_bytes)} bytes, streaming')
            self._output_video(mp4_bytes)
        else:
            _log('close: encode failed')

        self._cleanup()

    # ------------------------------------------------------------------
    # Image stream handling -- accumulate each frame in memory
    # ------------------------------------------------------------------

    def writeImage(self, action: AVI_ACTION, mimeType: str, buffer: bytes):
        if action == AVI_ACTION.BEGIN:
            self._image_buf = bytearray()
            self._image_mime = mimeType

        elif action == AVI_ACTION.WRITE:
            if buffer:
                self._image_buf.extend(buffer)

        elif action == AVI_ACTION.END:
            if self._image_buf:
                self._frames.append(bytes(self._image_buf))
            self._image_buf = bytearray()

    # ------------------------------------------------------------------
    # FFmpeg encoding via stdin/stdout pipe -- no temp files
    # ------------------------------------------------------------------

    def _encode_video(self) -> bytes | None:
        try:
            import imageio_ffmpeg as iff
            ffmpeg = iff.get_ffmpeg_exe()
        except Exception:
            ffmpeg = 'ffmpeg'

        input_codec = self._MIME_CODEC.get(self._image_mime, 'png')

        cmd = [
            ffmpeg,
            '-y',
            '-f', 'image2pipe',
            '-framerate', str(self._fps),
            '-vcodec', input_codec,
            '-i', 'pipe:0',
            '-c:v', self._codec,
            '-crf', str(self._crf),
            '-pix_fmt', 'yuv420p',
            # frag_keyframe+empty_moov allows MP4 to be written to a
            # non-seekable stdout without needing to rewrite the moov atom.
            '-movflags', 'frag_keyframe+empty_moov',
            '-f', 'mp4',
            'pipe:1',
        ]

        stdin_data = b''.join(self._frames)
        _log(f'_encode_video: frame_count={len(self._frames)} input_codec={input_codec} cmd={" ".join(cmd)}')
        try:
            proc = subprocess.Popen(
                cmd,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
            stdout, stderr = proc.communicate(input=stdin_data, timeout=300)
            _log(f'_encode_video: returncode={proc.returncode}')
            if proc.returncode != 0:
                _log(f'_encode_video: stderr={stderr.decode(errors="replace")[-500:]}')
                return None
            return stdout
        except (subprocess.TimeoutExpired, Exception) as e:
            _log(f'_encode_video: exception={e}')
            return None

    # ------------------------------------------------------------------
    # Write the encoded video to downstream nodes via the engine AVI mechanism
    # ------------------------------------------------------------------

    def _output_video(self, video_data: bytes):
        chunk_size = 48 * 1024
        self.instance.writeVideo(AVI_ACTION.BEGIN, 'video/mp4', b'')
        offset = 0
        while offset < len(video_data):
            chunk = video_data[offset:offset + chunk_size]
            self.instance.writeVideo(AVI_ACTION.WRITE, 'video/mp4', chunk)
            offset += chunk_size
        self.instance.writeVideo(AVI_ACTION.END, 'video/mp4', b'')

    # ------------------------------------------------------------------
    # Cleanup
    # ------------------------------------------------------------------

    def _cleanup(self):
        self._frames = []
