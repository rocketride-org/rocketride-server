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

# Frames stream straight through ffmpeg: one in on stdin, fragments out on stdout.
# Peak RAM is a frame plus whatever the engine has not yet drained.

import logging
import queue
import subprocess
import threading
from typing import ClassVar

from rocketlib import IInstanceBase, AVI_ACTION, Entry, warning
from ai.common.utils.subprocess_utils import close_stdin

from .IGlobal import IGlobal

_logger = logging.getLogger(__name__)

_VIDEO_MIME = 'video/mp4'

# How much of ffmpeg's stdout to take per read. Each read becomes one AVI WRITE.
_STDOUT_CHUNK = 64 * 1024

# Longest we wait for the encoder to drain and exit once its input is closed.
_ENCODE_TIMEOUT = 300

# Only the tail of ffmpeg's diagnostics is worth keeping when it fails.
_STDERR_TAIL = 4096


def _log(msg: str) -> None:
    _logger.debug(msg)


_PLOG = '/tmp/brandy_pipeline.log'


def _plog(msg: str) -> None:
    import datetime

    line = f'[{datetime.datetime.now().isoformat(timespec="milliseconds")}] [video_composer] {msg}\n'
    try:
        with open(_PLOG, 'a') as f:
            f.write(line)
    except OSError as e:
        # Read-only FS / disk full / permissions must not crash the pipeline.
        _logger.debug(f'_plog disabled due to file I/O error: {e}')


class IInstance(IInstanceBase):
    """Encodes incoming image frames into MP4 with FFmpeg, forwarding fragments as they appear."""

    IGlobal: IGlobal

    # Maps MIME type to the FFmpeg image2pipe input codec name
    _MIME_CODEC: ClassVar[dict[str, str]] = {
        'image/png': 'png',
        'image/jpeg': 'mjpeg',
        'image/jpg': 'mjpeg',
        'image/webp': 'webp',
        'image/bmp': 'bmp',
        'image/tiff': 'tiff',
    }

    def beginInstance(self):
        """Initialise per-instance state and load encoding settings from IGlobal.config."""
        self._image_buf = bytearray()
        self._image_mime = 'image/png'
        self._filename = 'output.mp4'
        self._proc = None
        self._stdout_queue: queue.Queue = queue.Queue()
        self._stdout_thread = None
        self._stderr_tail = b''
        self._stderr_thread = None
        self._frame_count = 0
        self._video_open = False

        cfg = self.IGlobal.config
        # Normalize numeric types up front so the range checks in _start_encode
        # can't blow up with TypeError/ValueError on non-numeric config values.
        try:
            self._fps = float(cfg.get('fps', 1.0))
            self._crf = int(cfg.get('crf', 23))
        except (TypeError, ValueError) as e:
            raise RuntimeError(f'Invalid video composer config values: {e}') from e
        self._codec = str(cfg.get('codec', 'libx264'))

    def endInstance(self):
        """Release per-instance resources."""
        self._cleanup()

    def open(self, obj: Entry):
        """Reset per-object state and capture the output filename from the entry."""
        self._frame_count = 0
        self._filename = (obj.name if obj.hasName else None) or 'output.mp4'
        _log('open: streaming encoder ready')
        _plog(f'open: filename={self._filename!r} obj.hasName={obj.hasName}')

    def close(self):
        """Finish the encode and close the video stream; no-op if no frames arrived."""
        _log(f'close: frame_count={self._frame_count}')
        _plog(f'close: frame_count={self._frame_count} filename={self._filename!r}')
        if self._proc is None:
            _plog('close: no frames -- nothing was encoded')
            self._cleanup()
            return

        ok = False
        try:
            ok = self._finish_encode()
        finally:
            if self._video_open:
                if ok:
                    self.instance.writeVideo(AVI_ACTION.END, _VIDEO_MIME, b'')
                else:
                    # Encode died mid-stream: the forwarded fragments are a truncated MP4.
                    # Skip the clean END so the response node never persists/announces a
                    # corrupt artifact as finished (the old "only a good encode leaves" rule).
                    warning('video_composer: encode failed; dropping the truncated stream (no END emitted)')
                self._video_open = False
            self._cleanup()

    def writeImage(self, action: AVI_ACTION, mimeType: str, buffer: bytes):
        """Accumulate one image; on END feed it to the encoder and forward its output.
        The encoder starts on the first frame, so fragments leave while frames arrive.
        """
        if action == AVI_ACTION.BEGIN:
            self._image_buf = bytearray()
            self._image_mime = mimeType

        elif action == AVI_ACTION.WRITE:
            if buffer:
                self._image_buf.extend(buffer)

        elif action == AVI_ACTION.END:
            frame = bytes(self._image_buf)
            self._image_buf = bytearray()
            if not frame:
                return
            if self._proc is None and not self._start_encode():
                return
            self._feed_frame(frame)
            self._drain_stdout()

    def _feed_frame(self, frame: bytes) -> None:
        """Write one frame to ffmpeg. A dead encoder ends the stream, it never raises."""
        if self._proc is None or self._proc.stdin.closed:
            return
        try:
            self._proc.stdin.write(frame)
            self._proc.stdin.flush()
            self._frame_count += 1
        except (BrokenPipeError, OSError, ValueError) as e:
            _log(f'_feed_frame: encoder went away after {self._frame_count} frames: {e}')
            self._close_stdin()

    def _drain_stdout(self) -> None:
        """Forward what the encoder produced so far, without blocking.
        A thread reads stdout, but writeVideo only ever runs here, on the engine thread.
        """
        while True:
            try:
                chunk = self._stdout_queue.get_nowait()
            except queue.Empty:
                return
            if not self._video_open:
                self.instance.writeVideo(AVI_ACTION.BEGIN, _VIDEO_MIME, b'')
                self._video_open = True
            self.instance.writeVideo(AVI_ACTION.WRITE, _VIDEO_MIME, chunk)

    def _close_stdin(self) -> None:
        close_stdin(self._proc)

    def _finish_encode(self) -> bool:
        """Close the input, drain the rest of the encoder's output, and reap it.
        Returns True only on a clean exit — a nonzero code means the forwarded fragments
        are a truncated stream the caller must not close with a normal END.
        """
        self._close_stdin()
        if self._stdout_thread is not None:
            self._stdout_thread.join(timeout=_ENCODE_TIMEOUT)
        self._drain_stdout()

        try:
            self._proc.wait(timeout=_ENCODE_TIMEOUT)
        except subprocess.TimeoutExpired:
            _log('_finish_encode: encoder did not exit; killing it')
            self._proc.kill()
            self._proc.wait()

        if self._stderr_thread is not None:
            self._stderr_thread.join(timeout=5)
        if self._proc.returncode != 0:
            warning(
                f'video_composer: encode failed (returncode={self._proc.returncode}) after '
                f'{self._frame_count} frames; stderr={self._stderr_tail.decode(errors="replace")[-500:]}'
            )
            return False
        _log(f'_finish_encode: ok, {self._frame_count} frames encoded')
        return True

    # ------------------------------------------------------------------
    # FFmpeg encoding via stdin/stdout pipe -- no temp files
    # ------------------------------------------------------------------

    _ALLOWED_CODECS: ClassVar[frozenset[str]] = frozenset(
        {
            'libx264',
            'libx265',
            'libvpx',
            'libvpx-vp9',
            'libaom-av1',
            'h264_nvenc',
            'hevc_nvenc',
            'h264_videotoolbox',
            'hevc_videotoolbox',
        }
    )

    def _start_encode(self) -> bool:
        """Launch ffmpeg with pipes on both ends. Returns False if it cannot start."""
        # Validate config values before building the subprocess command.
        if self._codec not in self._ALLOWED_CODECS:
            _log(f'_start_encode: unsupported codec={self._codec!r}')
            return False
        if not (0 <= self._crf <= 51):
            _log(f'_start_encode: crf={self._crf} out of range [0, 51]')
            return False
        if not (0 < self._fps <= 240):
            _log(f'_start_encode: fps={self._fps} out of valid range (0, 240]')
            return False

        try:
            import imageio_ffmpeg as iff
        except ImportError:
            ffmpeg = 'ffmpeg'
        else:
            try:
                ffmpeg = iff.get_ffmpeg_exe()
            except AttributeError:
                ffmpeg = 'ffmpeg'

        input_codec = self._MIME_CODEC.get(self._image_mime, 'png')

        cmd = [
            ffmpeg,
            '-y',
            '-f',
            'image2pipe',
            '-framerate',
            str(self._fps),
            '-vcodec',
            input_codec,
            '-i',
            'pipe:0',
            '-c:v',
            self._codec,
            '-crf',
            str(self._crf),
            '-pix_fmt',
            'yuv420p',
            # frag_keyframe+empty_moov: playable before the encode ends, no moov to
            # rewrite. default_base_moof: MSE rejects a tfhd base-data-offset.
            '-movflags',
            'frag_keyframe+empty_moov+default_base_moof',
            '-f',
            'mp4',
            'pipe:1',
        ]

        _log(f'_start_encode: input_codec={input_codec} cmd={" ".join(cmd)}')
        try:
            self._proc = subprocess.Popen(
                cmd,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
        except (OSError, subprocess.SubprocessError) as e:
            _log(f'_start_encode: ffmpeg failed to start: {e}')
            self._proc = None
            return False

        self._stdout_thread = threading.Thread(target=self._pump_stdout, daemon=True)
        self._stdout_thread.start()
        self._stderr_thread = threading.Thread(target=self._pump_stderr, daemon=True)
        self._stderr_thread.start()
        return True

    def _pump_stdout(self) -> None:
        """Drain ffmpeg's stdout into the queue. ffmpeg stalls if nobody reads it."""
        try:
            while chunk := self._proc.stdout.read(_STDOUT_CHUNK):
                self._stdout_queue.put(chunk)
        except (OSError, ValueError):
            pass

    def _pump_stderr(self) -> None:
        """Keep the last of ffmpeg's diagnostics, and keep its stderr pipe from filling."""
        try:
            self._stderr_tail = self._proc.stderr.read()[-_STDERR_TAIL:]
        except (OSError, ValueError):
            pass

    def _cleanup(self) -> None:
        """Reap a leftover encoder and reset per-object state."""
        if self._proc is not None and self._proc.poll() is None:
            self._close_stdin()
            self._proc.kill()
            self._proc.wait()
        self._proc = None
        self._stdout_thread = None
        self._stderr_thread = None
        self._stdout_queue = queue.Queue()
        self._stderr_tail = b''
        self._image_buf = bytearray()
        self._filename = 'output.mp4'
