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

from typing import Callable, Any
from .IGlobal import IGlobal
from ai.common.avi.audio import AudioReader
from rocketlib import debug


class Transcribe(AudioReader):
    """
    Transcribe class for detecting and transcribing spoken audio from a stream.

    - Uses ai.common.models.Whisper (model server or local) for transcription with built-in VAD.

    Audio chunks are streamed into the instance. It buffers audio and sends
    it to the Whisper model at regular intervals (default 60 seconds).
    Whisper's built-in VAD handles pause detection and speech segmentation.
    This is much more efficient than external VAD processing.
    """

    IGlobal: IGlobal  # Shared global context (optional external application state)

    # Constants for audio processing
    SAMPLE_RATE = 16000  # Required input sample rate for Whisper
    CHANNELS = 1  # Mono audio
    CHUNK_DURATION = 60  # Send audio to Whisper every 60 seconds
    MAX_CHUNK_DURATION = 120  # Maximum chunk duration before forcing transcription
    CHUNK_SAMPLES = SAMPLE_RATE * CHUNK_DURATION
    MAX_CHUNK_SAMPLES = SAMPLE_RATE * MAX_CHUNK_DURATION

    def __init__(
        self,
        segment_callback: Callable[[str], None],  # Callback to send transcribed text to
        transcribe: Callable[[Any], Any],  # Callback to transcribe audio data
        **kwargs,
    ):
        """
        Initialize the Transcribe instance.
        """
        # Get the optional parameters from kwargs
        chunk_duration: int = kwargs.get('chunk_duration', self.CHUNK_DURATION)
        max_chunk_duration: int = kwargs.get('max_chunk_duration', self.MAX_CHUNK_DURATION)

        # The whisper model is passed to us
        self._transcribe = transcribe

        # The callback to call when we have text
        self._segment_callback = segment_callback

        # Buffering parameters
        self._chunk_samples = chunk_duration * self.SAMPLE_RATE
        self._max_chunk_samples = max_chunk_duration * self.SAMPLE_RATE

        # Audio extractor that calls onData on each decoded PCM chunk
        super().__init__(
            name='transcribe',
            format='pcm',  # Raw PCM output
            sample_rate=self.SAMPLE_RATE,
            channels=self.CHANNELS,
            **kwargs,
        )

    def _build_text(self, segments: list, timestamp: float) -> list[tuple[int, str]]:
        """
        Combine segments where they do not end with terminal punctuation.

        Args:
            segments (list): List of segments from Whisper.
            timestamp (float): Base timestamp for this audio chunk.

        Returns:
            list: List of tuples (seek, text) representing complete merged sentences.
        """
        output = []

        terminal_punct = {'.', '?', '!'}
        accum_text = ''
        accum_start = None  # Use None to detect unset state

        for segment in segments:
            text = segment.text.strip()

            if accum_start is None:
                accum_start = segment.start  # Set on first segment of accumulation
            else:
                accum_text += ' '

            accum_text += text

            if text and text[-1] in terminal_punct:
                output.append((timestamp + accum_start, accum_text))
                accum_text = ''
                accum_start = None

        if accum_text:
            output.append((timestamp + accum_start, accum_text))

        return output

    def _flush_audio(self):
        """
        Flush the current buffered audio and send it to the Whisper model for transcription.
        """
        if not self._audio_chunks or self._total_samples == 0:
            return  # No audio to process

        # Snapshot current buffers FIRST, then clear immediately
        # This prevents race condition where audio keeps accumulating during transcription
        chunks_to_process = self._audio_chunks
        timestamp = self._audio_timestamp if self._audio_timestamp is not None else 0.0

        # Clear buffers NOW so new audio can accumulate while we transcribe
        self._audio_chunks = []
        self._total_samples = 0
        self._audio_timestamp = None

        # Concatenate all buffered PCM int16 chunks (16 kHz mono)
        combined_bytes = b''.join(chunks_to_process)

        # Transcribe using Whisper (model server or local via ai.common.models)
        segments_list = self._transcribe(combined_bytes)

        # Massage the text a bit
        text_segments = self._build_text(segments_list, timestamp)

        # Call the text callback with the transcribed text
        self._segment_callback(text_segments)

    def onData(self, chunk: bytes):
        """
        Handle incoming PCM audio.

        Args:
            chunk (bytes): PCM bytes (mono, 16-bit). None means end of stream.
        """
        if chunk is None:
            self._flush_audio()
            return

        # If this is the first chunk, save the timestamp
        if self._audio_timestamp is None:
            self._audio_timestamp = self.getTimestamp()

        # Append raw bytes to buffer list (very efficient - no copying!)
        self._audio_chunks.append(chunk)
        self._total_samples += len(chunk) // 2  # 2 bytes per int16 sample

        # Check if we should flush
        # Flush every 60 seconds, or force flush at 120 seconds max
        if self._total_samples >= self._chunk_samples:
            self._flush_audio()
        elif self._total_samples >= self._max_chunk_samples:
            self._flush_audio()

    def outputText(self, text: str):
        """
        Output transcribed text. Override to customize output.

        Args:
            text (str): Transcribed segment of speech.
        """
        debug(f'[Transcribed]: {text}')

    def start(self):
        """
        Begins audio decoding stream.

        Args:
            mime_type (str): MIME type of the incoming stream (e.g., 'audio/mp3').
        """
        # Initialize buffers
        self._audio_chunks = []  # List of byte chunks (efficient!)
        self._total_samples = 0  # Track total samples buffered
        self._audio_timestamp = None

        # Start the extractor
        super().start()

    def stop(self):
        """
        End audio stream and flush pending audio.
        """
        # Stop the extraction
        super().stop()  # Stop the audio extractor

        # Flush any remaining audio
        self._flush_audio()
