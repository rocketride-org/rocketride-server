# =============================================================================
# MIT License
# Copyright (c) 2024 RocketRide Inc.
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

    def onData(self, data: bytes):
        """
        Accumulate small chunks and enqueue 16K buffers for playback.

        Args:
            data (bytes): Raw PCM audio data.
        """
        # Signal end of playback if no data is received
        if not data:
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

        Plays back accumulated chunks until exhausted, then stops cleanly without padding silence.
        """
        required_bytes = frames * self.CHANNELS * 2  # 2 bytes per int16 sample
        buf = self._play_callback_buffer

        # If playback is marked finished, don't try to get more
        if self._playback_finished:
            if len(buf) == 0:
                raise sd.CallbackStop()
        else:
            # Fill buffer until we have enough or hit the end of data
            while len(buf) < required_bytes:
                chunk = self._play_queue.get()
                if chunk is None:
                    self._playback_finished = True
                    break
                buf.extend(chunk)

        # If we have less than we need and we are finished... stop. This will cut off like
        # the last 24ms of the audio
        if self._playback_finished and len(buf) < required_bytes:
            raise sd.CallbackStop()

        # Normal playback: fill full frame
        samples = np.frombuffer(buf[:required_bytes], dtype=np.int16).reshape(frames, self.CHANNELS)

        # Save it
        outdata[:] = samples

        # Remove the bytes we just played
        del buf[:required_bytes]

        # Save the new buffer
        self.play_callback_buffer = buf

    def start(self):
        """
        Start the audio playback stream and the data extractor.
        """
        # Initialize internal buffers
        self._chunk_accumulator = bytearray()
        self._play_callback_buffer = bytearray()
        self._playback_finished = False

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

        # Wait until the queue is drained and all buffered audio is played
        while not self._play_queue.empty() or len(self._play_callback_buffer) > 0 or not self._playback_finished:
            time.sleep(0.1)  # Wait 100ms

        # Stop the audio stream if it exists
        if self._stream:
            self._stream.stop()
            self._stream.close()
            self._stream = None
