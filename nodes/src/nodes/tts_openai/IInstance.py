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

from rocketlib import AVI_ACTION, IInstanceBase, debug, warning
from .IGlobal import IGlobal, FORMAT_MIME_TYPES


class IInstance(IInstanceBase):
    """
    Instance class responsible for handling text input and producing audio output.

    Receives text via the text lane, sends it to the OpenAI TTS API, and
    writes the resulting audio data to the audio output lane.
    """

    IGlobal: IGlobal

    def writeText(self, text: str):
        """
        Receive text input and convert it to speech audio.

        Args:
            text: The text content to synthesize into speech.
        """
        if not text or not text.strip():
            debug('TTS: skipping empty text input')
            return

        text = text.strip()

        # Check that the client is available
        if not self.IGlobal._client:
            warning('TTS: OpenAI client not initialized')
            return

        try:
            # Call the OpenAI TTS API
            response = self.IGlobal._client.audio.speech.create(
                model=self.IGlobal._model,
                voice=self.IGlobal._voice,
                input=text,
                speed=self.IGlobal._speed,
                response_format=self.IGlobal._response_format,
            )

            # Read the audio content from the response
            audio_data = response.content

            if not audio_data:
                warning('TTS: received empty audio response from OpenAI')
                return

            # Determine the MIME type for the audio output
            mime_type = FORMAT_MIME_TYPES.get(self.IGlobal._response_format, 'audio/mpeg')

            # Write audio output using the AVI action pattern
            self.instance.writeAudio(AVI_ACTION.BEGIN, mime_type)
            self.instance.writeAudio(AVI_ACTION.WRITE, mime_type, audio_data)
            self.instance.writeAudio(AVI_ACTION.END, mime_type)

            debug(f'TTS: generated {len(audio_data)} bytes of {self.IGlobal._response_format} audio')

        except Exception as e:
            # Import OpenAI error types for granular handling
            try:
                from openai import RateLimitError, APIConnectionError
            except ImportError:
                RateLimitError = None
                APIConnectionError = None

            # Rate-limit and connection errors are transient; warn but don't re-raise
            if RateLimitError is not None and isinstance(e, RateLimitError):
                warning(f'TTS: rate limited by OpenAI, skipping this request: {e}')
            elif APIConnectionError is not None and isinstance(e, APIConnectionError):
                warning(f'TTS: connection error (transient), skipping this request: {e}')
            else:
                # Non-transient errors must propagate so the pipeline knows it failed
                warning(f'TTS: failed to generate speech: {e}')
                raise
