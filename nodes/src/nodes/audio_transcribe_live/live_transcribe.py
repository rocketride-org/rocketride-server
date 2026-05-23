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

import collections
import threading
import time
from typing import Any, Callable, Deque, Optional

from rocketlib import debug, monitorStatus


class LiveTranscriber:
    """
    Capture microphone audio and emit rolling partial transcripts.

    Audio is collected at 16 kHz mono. Every ``chunk_interval`` seconds the
    last ``window_seconds`` of audio is sent to Whisper. New words are written
    to the open pipeline pipe as incremental ``text`` lane data.
    """

    SAMPLE_RATE = 16000
    CHANNELS = 1
    BYTES_PER_SAMPLE = 2

    def __init__(
        self,
        transcribe: Callable[[bytes], list],
        chunk_interval: float = 1.5,
        window_seconds: float = 4.0,
        device: Optional[int] = None,
        silence_reset_seconds: float = 1.0,
    ):
        self._transcribe = transcribe
        self._chunk_interval = max(0.5, float(chunk_interval))
        self._window_seconds = max(1.0, float(window_seconds))
        self._device = None if device is None or int(device) < 0 else int(device)
        self._silence_reset_seconds = max(0.5, float(silence_reset_seconds))

        self._max_window_bytes = int(self.SAMPLE_RATE * self._window_seconds * self.BYTES_PER_SAMPLE)
        self._min_window_bytes = int(self.SAMPLE_RATE * 0.4 * self.BYTES_PER_SAMPLE)

        self._audio_buffer: Deque[bytes] = collections.deque()
        self._buffer_bytes = 0
        self._buffer_lock = threading.Lock()
        self._stop = threading.Event()

        self._phrase_text = ''
        self._last_voice_time = 0.0
        self._stream: Any = None

    def stop(self):
        """Signal the capture loop to exit."""
        self._stop.set()

    def _audio_callback(self, indata, frames, time_info, status):
        import numpy as np

        if self._stop.is_set():
            return
        if status:
            debug(f'Live STT mic status: {status}')

        chunk = np.asarray(indata, dtype=np.int16).tobytes()
        if not chunk:
            return

        with self._buffer_lock:
            self._audio_buffer.append(chunk)
            self._buffer_bytes += len(chunk)
            while self._buffer_bytes > self._max_window_bytes and self._audio_buffer:
                removed = self._audio_buffer.popleft()
                self._buffer_bytes -= len(removed)

    def _get_window(self) -> bytes:
        with self._buffer_lock:
            return b''.join(self._audio_buffer)

    def _segments_to_text(self, segments: list) -> str:
        parts = [segment.text.strip() for segment in segments if getattr(segment, 'text', '').strip()]
        return ' '.join(parts).strip()

    def _compute_delta(self, new_text: str) -> str:
        if not new_text:
            return ''

        if not self._phrase_text:
            return new_text

        if new_text.startswith(self._phrase_text):
            delta = new_text[len(self._phrase_text) :]
            if delta and not delta.startswith(' '):
                delta = ' ' + delta
            return delta

        # Whisper revised the partial transcript — start a fresh phrase chunk.
        return (' ' if self._phrase_text else '') + new_text

    def _emit_partial(self, pipe, new_text: str):
        now = time.time()

        if not new_text:
            if self._phrase_text and self._last_voice_time:
                if now - self._last_voice_time >= self._silence_reset_seconds:
                    pipe.writeText('\n')
                    monitorStatus('Live STT: listening...')
                    self._phrase_text = ''
                    self._last_voice_time = 0.0
            return

        self._last_voice_time = now
        delta = self._compute_delta(new_text)
        self._phrase_text = new_text

        if not delta:
            return

        pipe.writeText(delta)
        preview = new_text if len(new_text) <= 80 else '...' + new_text[-77:]
        monitorStatus(f'Live STT: {preview}')

    def _process_window(self, pipe):
        audio = self._get_window()
        if len(audio) < self._min_window_bytes:
            self._emit_partial(pipe, '')
            return

        segments = self._transcribe(audio)
        text = self._segments_to_text(segments)
        self._emit_partial(pipe, text)

    def run(self, pipe):
        """
        Block until :meth:`stop` is called, streaming partial text to ``pipe``.

        Args:
            pipe: An open pipeline pipe instance from ``target.getPipe()``.
        """
        import sounddevice as sd

        blocksize = int(self.SAMPLE_RATE * 0.05)
        monitorStatus('Live STT: listening on microphone...')

        with sd.InputStream(
            samplerate=self.SAMPLE_RATE,
            channels=self.CHANNELS,
            dtype='int16',
            callback=self._audio_callback,
            blocksize=blocksize,
            device=self._device,
            latency='low',
        ):
            next_process = time.monotonic()
            while not self._stop.is_set():
                time.sleep(0.05)
                if time.monotonic() < next_process:
                    continue
                self._process_window(pipe)
                next_process = time.monotonic() + self._chunk_interval

        # Final pass on any trailing audio
        self._process_window(pipe)
        if self._phrase_text:
            pipe.writeText('\n')
