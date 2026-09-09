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

import threading
import queue
import time
import numpy as np
import sounddevice as sd
from ai.common.avi.audio import AudioReader
from .IGlobal import IGlobal


class Player(AudioReader):
    """
    A PCM audio player that consumes chunks and plays them using sounddevice.
    """

    # Constants for audio processing
    SAMPLE_RATE = 44100
    CHANNELS = 2  # Stereo audio
    MAX_CHUNK_SIZE = 16 * 1024  # 16 KB per chunk
    MAX_QUEUE_SIZE = 32  # Max chunks in queue

    IGlobal: IGlobal  # Shared global context (optional external application state)

    def __init__(self, lock: threading.Lock, **kwargs):
        """
        Initialize the Player instance.

        Args:
            lock (threading.Lock): Optional lock for thread-safe operations.
            **kwargs: Additional keyword arguments for the AudioReader superclass.
        """
        self._play_queue = queue.Queue(maxsize=self.MAX_QUEUE_SIZE)
        self._chunk_accumulator = bytearray()
        self._play_callback_buffer = bytearray()
        self._stream = None

        super().__init__(
            name='player',
            format='pcm',  # Raw PCM output
            sample_rate=self.SAMPLE_RATE,
            channels=self.CHANNELS,
            lock=lock,
            **kwargs,
        )

    def onData(self, data: bytes | None):
        """
        Accumulate small chunks and enqueue 16K buffers for playback.

        Args:
            data (bytes | None): Raw PCM audio data, or None at end-of-stream.
        """
        # Signal end of playback if no data is received
        if not data:
            # Flush whatever never reached a full 16K chunk, otherwise the tail of
            # every stream (and any stream shorter than 16K) is silently dropped.
            if self._chunk_accumulator:
                # Blocks if queue is full, preserving the same backpressure as full chunks
                self._play_queue.put(bytes(self._chunk_accumulator))
                self._chunk_accumulator = bytearray()

            self._play_queue.put(None)  # Signal end of playback
            return

        self._chunk_accumulator.extend(data)

        while len(self._chunk_accumulator) >= self.MAX_CHUNK_SIZE:
            chunk = self._chunk_accumulator[: self.MAX_CHUNK_SIZE]
            self._chunk_accumulator = self._chunk_accumulator[self.MAX_CHUNK_SIZE :]

            # Blocks if queue is full, so limits chunks in queue to MAX_QUEUE_SIZE
            self._play_queue.put(chunk)

    def _audio_callback(self, outdata, frames, time_info, status):
        """
        sounddevice.OutputStream callback to feed audio data.

        Plays back accumulated chunks until exhausted. The final block is padded with
        silence so the last partial block is played instead of being cut off.
        """
        required_bytes = frames * self.CHANNELS * 2  # 2 bytes per int16 sample
        buf = self._play_callback_buffer

        # If playback is marked finished, don't try to get more
        if self._playback_finished:
            if len(buf) == 0:
                outdata.fill(0)
                raise sd.CallbackStop()
        else:
            # Fill buffer until we have enough or hit the end of data
            while len(buf) < required_bytes:
                chunk = self._play_queue.get()
                if chunk is None:
                    self._playback_finished = True
                    break
                buf.extend(chunk)

        # End of stream with less than a full block left: play what remains, pad the
        # rest with silence, and stop after sounddevice commits this terminal block.
        if self._playback_finished and len(buf) < required_bytes:
            frame_bytes = self.CHANNELS * 2
            tail_bytes = (len(buf) // frame_bytes) * frame_bytes  # whole frames only

            # sounddevice requires every output callback to fill the whole buffer,
            # including the callback that raises CallbackStop.
            outdata.fill(0)

            # Nothing playable left (EOF on a block boundary or a torn PCM frame).
            if tail_bytes == 0:
                buf.clear()
                self._play_callback_buffer = buf
                raise sd.CallbackStop()

            tail = np.frombuffer(buf[:tail_bytes], dtype=np.int16).reshape(-1, self.CHANNELS)
            outdata[: len(tail)] = tail

            buf.clear()
            self._play_callback_buffer = buf
            raise sd.CallbackStop()

        # Normal playback: fill full frame
        samples = np.frombuffer(buf[:required_bytes], dtype=np.int16).reshape(frames, self.CHANNELS)

        # Save it
        outdata[:] = samples

        # Remove the bytes we just played
        del buf[:required_bytes]

        # Save the new buffer
        self._play_callback_buffer = buf

    def write(self, buffer: bytes):
        self._wrote_any_data = True
        super().write(buffer)

    def start(self):
        """
        Start the audio playback stream and the data extractor.
        """
        # Initialize internal buffers
        self._chunk_accumulator = bytearray()
        self._play_callback_buffer = bytearray()
        self._playback_finished = False
        self._wrote_any_data = False

        # Create and start the audio output stream
        self._stream = sd.OutputStream(
            samplerate=self.SAMPLE_RATE,
            channels=self.CHANNELS,
            dtype='int16',
            callback=self._audio_callback,
            latency='low',
            blocksize=1024,
        )

        self._stream.start()

        # Start the parent extractor
        super().start()

    def stop(self):
        """
        Stop audio stream and ensure all buffered audio is played.
        """
        # Stop parent processing
        super().stop()

        # Nothing was ever written, so nothing will ever set _playback_finished
        # (only onData, driven by the ffmpeg thread WRITE starts, does that) -
        # waiting here would hang forever on an empty stream.
        if self._wrote_any_data:
            # Wait until the queue is drained and all buffered audio is played
            while not self._play_queue.empty() or len(self._play_callback_buffer) > 0 or not self._playback_finished:
                time.sleep(0.1)  # Wait 100ms

        # Stop the audio stream if it exists
        if self._stream:
            self._stream.stop()
            self._stream.close()
            self._stream = None
