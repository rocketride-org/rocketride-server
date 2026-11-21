# MIT License
#
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in all
# copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.

"""
Video frame extraction over an ffmpeg subprocess.

``VideoFrameExtractor`` turns one video stream into a sequence of PNG frames,
selected by interval, scene transition, keyframe or an explicit list of frame
numbers, and pairs each PNG with the frame number and timestamp ffmpeg's
``showinfo`` filter reports for it.
"""

import re
import queue
from typing import Dict, Any, List
from typing import Callable

from rocketlib import warning

from .reader import AVIReader

# How long a complete PNG waits for its showinfo entry before the frame is left buffered.
# The entry is written by ffmpeg alongside the frame, so this is generous; its job is to
# bound the wait rather than to time real work.
_FRAME_INFO_TIMEOUT = 5.0

# showinfo prints pts_time with six decimals, so a frame ffmpeg kept at exactly the
# start time can read back a hair below it.
_PTS_TOLERANCE = 1e-6


def frames_select(frames: List[int]) -> str:
    """
    Build the ffmpeg ``select`` filter that passes exactly the listed frames.

    ``n`` in a ``select`` expression counts every decoded frame from 0 at the start of
    the video, so the numbers are absolute whatever start time the extractor seeks to.

    Args:
        frames: The frame numbers, sorted and without duplicates.

    Returns:
        str: The filter, quoted for the filtergraph so its commas stay inside the
        expression; ``select=0`` (pass nothing) for an empty list.
    """
    # An empty list selects nothing rather than handing ffmpeg an empty expression
    if not frames:
        return 'select=0'
    return "select='" + '+'.join(f'eq(n,{number})' for number in frames) + "'"


class VideoFrameExtractor(AVIReader):
    """
    Class to manage video frame extraction from a video stream and pass frames as raw data.

    Inherits from AVIReader to handle FFmpeg subprocesses for video decoding.
    """

    SOI = b'\x89PNG\r\n\x1a\n'
    EOI = b'\x00\x00\x00\x00IEND\xaeB`\x82'

    def __init__(self, frame_callback: Callable[[bytes, int, float], None], *, name: str, config: Dict[str, Any]):
        """
        Initialize the video frame grabber.

        Takes a structure as:
            {
            type: 'interval' | 'key' | 'transition' | 'frames',
            start_time: float,
            duration: float,
            scale_width: int,
            scale_height: int,
            fps: float,
            max_frames: int,
            percent: float (0.0 to 1.0 for transition),
            frames: list[int] (frame numbers from 0 at the start of the video, for frames),
            }

        Args:
            frame_callback: Receives ``(png, frame_number, seconds)`` per frame, and
                ``(None, 0, 0)`` once the stream ends.
            name: The reader's name in log lines.
            config: The structure above.
        """
        # Save the frame callback function
        self._frame_callback = frame_callback

        # Initialize queue to store frame information
        self._frame_info_queue = queue.Queue()

        # Get the type
        self._type = config.get('type', 'interval')

        # The start time is where showinfo entries start counting (see onInfo)
        self._start_time = config.get('start_time', 0.0)
        self._duration = config.get('duration', 0.0)

        # The frames mode's list, sorted so the n-th frame select passes is the n-th
        # number in it (onInfo reports the number, not the ordinal)
        self._frames = sorted({int(number) for number in config.get('frames') or []})

        # Determine fps setting
        self._fps = config.get('fps', 1.0)

        if self._fps >= 1:
            fps_string = f'fps={int(self._fps)}'
        else:
            fps_string = f'fps=1/{round(1 / self._fps)}'

        # Common ffmpeg args. -ss after the input is an OUTPUT seek: the filters below
        # still see every frame from the start of the video, and the frames before the
        # start time are dropped after them (onInfo skips their showinfo entries)
        args = [
            '-ss',
            f'{self._start_time}',
        ]

        # Initialize filters list
        filters = []

        # Add scale filter if needed
        self._scale_width = config.get('scale_width', -1)
        self._scale_height = config.get('scale_height', -1)

        if not (self._scale_width == -1 and self._scale_height == -1):
            filters.append(f'scale={self._scale_width}:{self._scale_height}')

        # Type-specific video filters
        if self._type == 'transition':
            self._percent = config.get('percent', 0.4)
            filters.append(f"select='gt(scene,{self._percent})'")
        elif self._type == 'key':
            filters.append("select='eq(pict_type,I)'")
        elif self._type == 'interval':
            filters.append(f'{fps_string}')
        elif self._type == 'frames':
            filters.append(frames_select(self._frames))
        else:
            raise ValueError(f'Unknown frame grab type: {self._type}')

        # Always add showinfo at the end of the filter chain
        filters.append('showinfo')

        # Join filters into a single string
        vf = ','.join(filters)

        # Add additional arguments for the ffmpeg command
        args += ['-vf', vf]

        # Add max frames if specified
        self._max_frames = config.get('max_frames', None)
        if self._max_frames:
            args += ['-frames:v', str(self._max_frames)]

        # If there is a duration
        if self._duration:
            args += ['-t', str(self._duration)]

        # Add additional arguments for the ffmpeg command
        args += [
            '-f',
            'image2pipe',
            '-fps_mode',
            'passthrough',
            '-vcodec',
            'png',
            '-',  # Output to stdout
            '-hide_banner',
            '-loglevel',
            'info',
        ]

        super().__init__(args, name=name)

    def extract_complete_png(self, data: bytes) -> tuple[bytes, int] | None:
        """
        Extract a complete PNG image from the start of `data`.

        Args:
            data (bytes): The buffer containing PNG data (may have extra trailing bytes).

        Returns:
            Tuple[bytes, int]: (complete_png_bytes, end_offset)
                - complete_png_bytes: the extracted PNG image bytes including signature and IEND chunk.
                - end_offset: position in `data` immediately after the extracted PNG.
            None if no complete PNG is found.
        """
        PNG_SIG = b'\x89PNG\r\n\x1a\n'  # PNG signature (SOI)

        # Find PNG signature
        pos = data.find(PNG_SIG)
        if pos == -1:
            # No PNG start found
            return None

        # Start parsing chunks after the signature
        i = pos + len(PNG_SIG)
        while i + 8 <= len(data):  # Need at least 8 bytes for length + chunk type
            # Read chunk length (4 bytes, big-endian)
            length = int.from_bytes(data[i : i + 4], byteorder='big')
            # Read chunk type (4 bytes)
            chunk_type = data[i + 4 : i + 8]

            # Calculate total chunk length: length(4) + type(4) + data(length) + crc(4)
            total_chunk_len = 4 + 4 + length + 4
            next_pos = i + total_chunk_len

            # Check if chunk fits inside the data buffer
            if next_pos > len(data):
                # Not enough data yet for this chunk — incomplete PNG
                return None

            # Move index to end of this chunk to read the next chunk in next iteration
            i = next_pos

            # Check if this is the IEND chunk (end of PNG)
            if chunk_type == b'IEND':
                # Return complete PNG data and end offset
                return bytes(data[pos:i]), i

        # If we exit loop without finding IEND, PNG is incomplete
        return None

    def _processBuffer(self):
        """
        Emit every complete PNG in the buffer, each with its own showinfo entry.

        Runs on the data thread. A PNG whose entry has not arrived within
        ``_FRAME_INFO_TIMEOUT`` stays buffered for the next chunk to retry.
        """
        while True:
            result = self.extract_complete_png(self._buffer)
            if not result:
                # No complete PNG image found yet
                return

            # Get the data and the offes
            png_data, end_offset = result

            # Frame info arrives on the stderr thread while the bytes arrive here, so a
            # brief wait is normal. Bounded rather than open-ended: with no entry coming
            # at all this used to block the data thread for good, and stop() would then
            # hang on its join(). Leaving the PNG buffered lets a later chunk retry it.
            try:
                frame_number, start_time = self._frame_info_queue.get(timeout=_FRAME_INFO_TIMEOUT)
            except queue.Empty:
                warning(f'[{self._name}]: no showinfo entry for a complete frame after {_FRAME_INFO_TIMEOUT}s')
                return

            # Callback with complete PNG frame. showinfo's pts_time already counts from
            # the start of the video (the seek is on the output), so it is the timestamp
            self._frame_callback(png_data, frame_number, start_time)

            # Remove processed bytes from buffer
            self._buffer = self._buffer[end_offset:]

    def onData(self, chunk: bytes = None):
        """
        Take a chunk of ffmpeg's stdout, or the end of it.

        Args:
            chunk: PNG bytes, or None once ffmpeg's output has ended, which is passed
                on to the callback as ``(None, 0, 0)``.
        """
        # Add the bytes to the existing buffer
        if chunk is not None:
            self._buffer.extend(chunk)
        else:
            self._done = True

        # Process the buffer
        self._processBuffer()

        # If we are done, signal end
        if chunk is None:
            self._frame_callback(None, 0, 0)

    def onInfo(self, info: str):
        """
        Queue the frame number and timestamp of each frame ffmpeg will emit.

        showinfo sits before the output seek, so it also reports the frames before the
        start time that ffmpeg then drops; their entries are skipped here, or every
        frame after them would carry an earlier frame's number and time.

        Args:
            info: One line of ffmpeg's stderr, or None at its end.
        """
        # If this is the end, then done
        if info is None:
            return

        # If this is not parser info, done
        if not info.startswith('[Parsed_showinfo_'):
            return

        # Example: [Parsed_showinfo_0 @ 0x55cd1be2b400] n:   1 pts: 90000 pts_time: 1.000000
        match = re.match(r'.*n:\s*(\d+)\s+pts:\s*(\d+)\s+pts_time:\s*([0-9.]+)', info)
        if not match:
            return

        # n counts the frames the select passed (seek-dropped ones included); pts_time
        # is from the start of the video
        frame_number = int(match.group(1))
        pts_time = float(match.group(3))

        # A frame before the start time never reaches the output: no PNG will claim it
        if pts_time < self._start_time - _PTS_TOLERANCE:
            return

        # In frames mode the n-th selected frame is the n-th listed number
        if self._type == 'frames' and frame_number < len(self._frames):
            frame_number = self._frames[frame_number]
        self._frame_info_queue.put((frame_number, pts_time))

    def start(self):
        """
        Start frame extraction from the video stream.

        This method configures FFmpeg to scale and extract frames as raw data.
        """
        # Initialize the frame buffer
        self._buffer: bytes = bytearray()

        # Reset these
        self._done = False
        self._buffer = bytearray()

        # Drop whatever the previous stream left queued. showinfo entries are pushed from
        # the stderr thread independently of PNG extraction, so a stream that ended with
        # entries still unread would hand its frame numbers and timestamps to the next one
        # — one object can carry several video streams, and this reader serves them in turn.
        while True:
            try:
                self._frame_info_queue.get_nowait()
            except queue.Empty:
                break

        # Start extractor process and feed video data to it via stdin
        super().start()
