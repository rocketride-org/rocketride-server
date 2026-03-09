# =============================================================================
# MIT License
# Copyright (c) 2026 RocketRide, Inc.
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
import shutil
import subprocess
import tempfile
import time

from rocketlib import IInstanceBase, AVI_ACTION, Entry

from .IGlobal import IGlobal

_LOG_PATH = '/tmp/objdet_debug.log'

class IInstance(IInstanceBase):
    IGlobal: IGlobal

    def beginInstance(self):
        self._frames_dir = None
        self._frame_count = 0
        self._image_buf = bytearray()
        self._image_mime = 'image/png'

        cfg = self.IGlobal.config
        self._fps = cfg.get('fps', 1.0)
        self._codec = cfg.get('codec', 'libx264')
        self._crf = int(cfg.get('crf', 23))

    def endInstance(self):
        self._cleanup()

    def open(self, obj: Entry):
        self._frames_dir = tempfile.mkdtemp(prefix='vcomp_frames_')
        self._frame_count = 0
        self._log(f'open: buffering frames to {self._frames_dir}')

    def close(self):
        self._log(f'close: {self._frame_count} frames received')
        if self._frame_count == 0:
            self._cleanup()
            return

        output_path = self._encode_video()
        if output_path and os.path.exists(output_path):
            file_size = os.path.getsize(output_path)
            self._log(f'encoded {output_path} ({file_size} bytes)')

            if self.instance.hasListener('video'):
                self._stream_video(output_path)

            try:
                os.remove(output_path)
            except OSError:
                pass

        self._cleanup()

    # ------------------------------------------------------------------
    # Image stream handling -- buffer each frame as a numbered PNG
    # ------------------------------------------------------------------

    def writeImage(self, action: AVI_ACTION, mimeType: str, buffer: bytes):
        if action == AVI_ACTION.BEGIN:
            self._image_buf = bytearray()
            self._image_mime = mimeType

        elif action == AVI_ACTION.WRITE:
            if buffer:
                self._image_buf.extend(buffer)

        elif action == AVI_ACTION.END:
            if self._frames_dir and self._image_buf:
                fname = f'frame_{self._frame_count:06d}.png'
                fpath = os.path.join(self._frames_dir, fname)
                with open(fpath, 'wb') as f:
                    f.write(self._image_buf)
                self._frame_count += 1
            self._image_buf = bytearray()

    # ------------------------------------------------------------------
    # FFmpeg encoding
    # ------------------------------------------------------------------

    def _encode_video(self) -> str | None:
        try:
            import imageio_ffmpeg as iff
            ffmpeg = iff.get_ffmpeg_exe()
        except Exception:
            ffmpeg = 'ffmpeg'

        output_path = os.path.join(
            tempfile.gettempdir(),
            f'vcomp_output_{int(time.time())}.mp4',
        )

        input_pattern = os.path.join(self._frames_dir, 'frame_%06d.png')
        cmd = [
            ffmpeg,
            '-y',
            '-framerate', str(self._fps),
            '-i', input_pattern,
            '-c:v', self._codec,
            '-crf', str(self._crf),
            '-pix_fmt', 'yuv420p',
            '-movflags', '+faststart',
            output_path,
        ]

        self._log(f'ffmpeg cmd: {" ".join(cmd)}')

        try:
            result = subprocess.run(
                cmd, capture_output=True, text=True, timeout=300,
            )
            if result.returncode != 0:
                self._log(f'ffmpeg failed (exit {result.returncode}): {result.stderr[:2000]}')
                return None
            return output_path
        except subprocess.TimeoutExpired:
            self._log('ffmpeg timed out')
            return None
        except Exception as e:
            self._log(f'ffmpeg error: {e}')
            return None

    # ------------------------------------------------------------------
    # Stream the encoded video downstream
    # ------------------------------------------------------------------

    def _stream_video(self, video_path: str):
        chunk_size = 64 * 1024
        self.instance.writeVideo(AVI_ACTION.BEGIN, 'video/mp4')
        with open(video_path, 'rb') as fh:
            while True:
                chunk = fh.read(chunk_size)
                if not chunk:
                    break
                self.instance.writeVideo(AVI_ACTION.WRITE, 'video/mp4', chunk)
        self.instance.writeVideo(AVI_ACTION.END, 'video/mp4')

    # ------------------------------------------------------------------
    # Cleanup
    # ------------------------------------------------------------------

    def _cleanup(self):
        if self._frames_dir and os.path.isdir(self._frames_dir):
            try:
                shutil.rmtree(self._frames_dir)
            except OSError:
                pass
        self._frames_dir = None
        self._frame_count = 0

    @staticmethod
    def _log(msg: str):
        with open(_LOG_PATH, 'a') as f:
            f.write(f'[VideoComposer] {msg}\n')
