import re
import queue
from typing import Dict, Any
from typing import Callable
from .reader import AVIReader


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
            type: 'interval' | 'key' | 'transition',
            start_time: float,
            duration: float,
            scale_width: int,
            scale_height: int,
            fps: float,
            max_frames: int,
            percent: float (0.0 to 1.0 for transition),
            }
        """
        # Save the frame callback function
        self._frame_callback = frame_callback

        # Initialize queue to store frame information
        self._frame_info_queue = queue.Queue()

        # Get the type
        self._type = config.get('type', 'interval')

        # Save the start time so we can adjust to pts_timestamp
        self._start_time = config.get('start_time', 0.0)
        self._duration = config.get('duration', 0.0)

        # Determine fps setting
        self._fps = config.get('fps', 1.0)
        if self._fps >= 1:
            fps_string = f'fps={int(self._fps)}'
        else:
            fps_string = f'fps=1/{int(1 / self._fps)}'

        # Common ffmpeg args
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
        while True:
            result = self.extract_complete_png(self._buffer)
            if not result:
                # No complete PNG image found yet
                return

            # Get the data and the offes
            png_data, end_offset = result

            # Get frame info
            frame_number, start_time = self._frame_info_queue.get()

            # Callback with complete PNG frame
            self._frame_callback(png_data, frame_number, start_time + self._start_time)

            # Remove processed bytes from buffer
            self._buffer = self._buffer[end_offset:]

    def onData(self, chunk: bytes = None):
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

        # Get the frame number and presentation time relative to our start time
        frame_number = int(match.group(1))
        pts_time = float(match.group(3))
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

        # Start extractor process and feed video data to it via stdin
        super().start()
