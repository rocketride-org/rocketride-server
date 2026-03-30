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

import os
import re

from rocketlib import IGlobalBase, OPEN_MODE, debug, warning
from ai.common.config import Config


# Valid values for TTS configuration
VALID_VOICES = {'alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'}
VALID_MODELS = {'tts-1', 'tts-1-hd'}
VALID_FORMATS = {'mp3', 'opus', 'aac', 'flac', 'wav', 'pcm'}

# MIME type mapping for response formats
FORMAT_MIME_TYPES = {
    'mp3': 'audio/mpeg',
    'opus': 'audio/opus',
    'aac': 'audio/aac',
    'flac': 'audio/flac',
    'wav': 'audio/wav',
    'pcm': 'audio/pcm',
}


class IGlobal(IGlobalBase):
    """
    Global configuration and setup for the OpenAI text-to-speech node.

    Handles API client initialization, configuration validation, and
    provides the shared OpenAI client for all instances.
    """

    _client = None
    _model: str = 'tts-1'
    _voice: str = 'alloy'
    _speed: float = 1.0
    _response_format: str = 'mp3'

    def validateConfig(self):
        """Validate the configuration for the OpenAI TTS node."""
        try:
            # Load dependencies
            from depends import depends

            requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
            depends(requirements)

            from openai import OpenAI, APIStatusError, AuthenticationError, RateLimitError, APIConnectionError, OpenAIError

            # Get config
            config = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
            apikey = config.get('apikey')
            model = config.get('model', 'tts-1')
            voice = config.get('voice', 'alloy')

            # Validate model
            if model not in VALID_MODELS:
                warning(f'Invalid TTS model: {model}. Must be one of: {", ".join(sorted(VALID_MODELS))}')
                return

            # Validate voice
            if voice not in VALID_VOICES:
                warning(f'Invalid voice: {voice}. Must be one of: {", ".join(sorted(VALID_VOICES))}')
                return

            # Simple API validation using provider-driven exceptions
            try:
                client = OpenAI(api_key=apikey)
                # Make a minimal request to validate the API key and model
                client.audio.speech.create(model=model, voice=voice, input='test', response_format='mp3')
            except APIStatusError as e:
                status = getattr(e, 'status_code', None) or getattr(e, 'status', None)
                message = str(e)
                try:
                    resp = getattr(e, 'response', None)
                    data = resp.json() if resp is not None else None
                    if isinstance(data, dict):
                        err = data.get('error')
                        etype = err.get('type') if isinstance(err, dict) else None
                        emsg = (err.get('message') if isinstance(err, dict) else None) or data.get('message')
                        parts = []
                        if status:
                            parts.append(f'Error {status}:')
                        if etype:
                            parts.append(etype)
                        if emsg:
                            if etype:
                                parts.append('-')
                            parts.append(emsg)
                        if parts:
                            message = ' '.join(parts)
                except Exception:
                    pass
                message = re.sub(r'\s+', ' ', message).strip()
                if len(message) > 500:
                    message = message[:500].rstrip() + '\u2026'
                warning(message)
                return
            except (AuthenticationError, RateLimitError, APIConnectionError, OpenAIError) as e:
                message = re.sub(r'\s+', ' ', str(e)).strip()
                if len(message) > 500:
                    message = message[:500].rstrip() + '\u2026'
                warning(message)
                return

        except Exception as e:
            warning(str(e))
            return

    def beginGlobal(self):
        """
        Initialize the global state.

        Reads configuration values, validates parameters, and creates
        the shared OpenAI client for TTS operations.
        """
        # Are we in config mode?
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return

        # Load dependencies
        from depends import depends

        requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
        depends(requirements)

        from openai import OpenAI

        # Get the passed configuration
        config = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)

        # Read and validate configuration
        self._model = config.get('model', 'tts-1')
        self._voice = config.get('voice', 'alloy')
        self._speed = config.get('speed', 1.0)
        self._response_format = config.get('response_format', 'mp3')
        apikey = config.get('apikey')

        # Clamp speed to valid range
        self._speed = max(0.25, min(4.0, float(self._speed)))

        # Validate voice
        if self._voice not in VALID_VOICES:
            self._voice = 'alloy'

        # Validate model
        if self._model not in VALID_MODELS:
            self._model = 'tts-1'

        # Validate response format
        if self._response_format not in VALID_FORMATS:
            self._response_format = 'mp3'

        # Create the OpenAI client
        self._client = OpenAI(api_key=apikey)

        debug(f'    TTS OpenAI: model={self._model}, voice={self._voice}, speed={self._speed}, format={self._response_format}')

    def endGlobal(self):
        """Clean up global state."""
        self._client = None
