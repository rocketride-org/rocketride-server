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

import time
from typing import Optional
from rocketlib import debug


class VideoPlayer:
    """
    Plays a video file in a window with optional burned-in subtitles.

    Subtitles are rendered via ffmpeg's `subtitles` video filter inside
    ffpyplayer's decode pipeline, which keeps subtitle overlay in sync with
    frame decoding. Audio playback is handled internally by ffpyplayer.
    """

    WINDOW_NAME = 'RocketRide Video Player'

    def __init__(self, video_path: str, srt_path: Optional[str] = None):
        """
        Hold paths to the video file and (optional) SRT file to play.

        Args:
            video_path (str): Absolute path to the video file to play.
            srt_path (Optional[str]): Absolute path to an SRT subtitle file.
                When provided, subtitles are burned into frames via ffmpeg's
                `subtitles` filter. When None, the video plays without subtitles.
        """
        self._video = video_path
        self._srt = srt_path

    @staticmethod
    def _escape_subtitles_path(path: str) -> str:
        """
        Escape a file path for use inside ffmpeg's `subtitles=` filter argument.

        Windows drive letters and backslashes need special handling because
        ffmpeg parses `:` as an argument separator.

        Args:
            path (str): Raw filesystem path to the SRT file.

        Returns:
            str: The path with backslashes normalized to forward slashes and
                colons / single quotes escaped so it can be embedded in the
                subtitles filter expression.
        """
        # Normalize slashes
        p = path.replace('\\', '/')
        # Escape colons (e.g., C:/...)
        p = p.replace(':', '\\:')
        # Escape single quotes in case the path contains them
        p = p.replace("'", r'\'')
        return p

    def play(self):
        """
        Open a window and play the configured video (with optional subtitles).

        Decodes via ffpyplayer, renders frames in an OpenCV window, and
        streams audio through ffpyplayer's internal audio output. Blocks
        until EOF, the user presses `q`/`Esc`, or an error is raised during
        decoding.

        Returns:
            None.
        """
        from ffpyplayer.player import MediaPlayer
        import cv2
        import numpy as np

        ff_opts = {}
        if self._srt:
            srt_arg = self._escape_subtitles_path(self._srt)
            ff_opts['vf'] = f"subtitles='{srt_arg}'"

        player = MediaPlayer(self._video, ff_opts=ff_opts)

        cv2.namedWindow(self.WINDOW_NAME, cv2.WINDOW_NORMAL)

        try:
            while True:
                frame, val = player.get_frame()
                if val == 'eof':
                    break

                if frame is None:
                    # No frame ready yet; sleep briefly and retry
                    time.sleep(0.005)
                    continue

                img, _pts = frame
                width, height = img.get_size()
                data = img.to_bytearray()[0]
                # ffpyplayer default pixel format is rgb24
                rgb = np.frombuffer(data, dtype=np.uint8).reshape(height, width, 3)
                bgr = rgb[:, :, ::-1]

                cv2.imshow(self.WINDOW_NAME, bgr)

                # Honor the returned `val` as the suggested wait-until-next-frame delay
                if isinstance(val, (int, float)) and val > 0:
                    wait_ms = max(1, int(val * 1000))
                else:
                    wait_ms = 1

                key = cv2.waitKey(wait_ms) & 0xFF
                if key in (ord('q'), 27):  # q or Esc to quit
                    break
        except Exception as e:
            debug(f'video_player error: {e}')
        finally:
            try:
                cv2.destroyWindow(self.WINDOW_NAME)
            except Exception:
                pass
            try:
                player.close_player()
            except Exception:
                pass
