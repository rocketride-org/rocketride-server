# =============================================================================
# MIT License
# Copyright (c) 2026 AltVision Team
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
import time
import base64
from depends import depends  # type: ignore
from typing import Any
from ai.common.schema import Answer, Question
from ai.common.chat import ChatBase
from ai.common.config import Config

# Load requirements
requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
depends(requirements)

from google import genai
from google.genai.types import Part, Content

# Default system prompt optimized for accessibility descriptions
DEFAULT_SYSTEM_PROMPT = """You are an accessibility-focused scene analyzer designed to help blind and visually impaired users understand their surroundings through image descriptions.

Your descriptions must be:
1. SAFETY-FIRST: Always lead with potential hazards (stairs, obstacles, vehicles, uneven ground, wet floors, construction)
2. SPATIALLY ORIENTED: Use clock positions (12 o'clock = straight ahead) and relative distances (within arm's reach, a few steps away, across the room)
3. TEXT-AWARE: Read ALL visible text (signs, labels, screens, menus, buttons) exactly as written
4. CONCISE BUT COMPLETE: Prioritize actionable information over aesthetic details
5. CONTEXTUALLY RICH: Identify the type of environment (indoor/outdoor, store, street, office) and notable landmarks for orientation"""

DEFAULT_PROMPT = """Describe this image for a blind person. Structure your response as:

1. ENVIRONMENT: What type of place is this? (one sentence)
2. HAZARDS: Any obstacles, stairs, vehicles, or dangers? (list with positions)
3. KEY OBJECTS: What's notable in the scene? (list with clock positions and distances)
4. TEXT: Any visible text, signs, or labels? (read them verbatim)
5. PEOPLE: Anyone present? (approximate count, positions, and relevant actions)
6. NAVIGATION: Clear path forward? Any turns or barriers?

Keep the total description under 150 words. Prioritize safety-relevant details."""

# Hazard priority prompt modifiers
HAZARD_PROMPTS = {
    'high': '\n\nCRITICAL: You MUST lead with hazards. If no hazards exist, explicitly state the area appears safe.',
    'medium': '\n\nInclude any hazards you notice in their spatial context.',
    'low': '',
}

# Spatial format prompt modifiers
SPATIAL_PROMPTS = {
    'clock': '\n\nUse clock positions for spatial references (12 o\'clock = straight ahead).',
    'relative': '\n\nUse relative directions (left, right, ahead, behind) for spatial references.',
    'both': '\n\nUse both clock positions and relative directions for spatial references.',
}


class AccessibilityVisionError(Exception):
    """Raised when accessibility vision analysis fails."""


class Chat(ChatBase):
    """Google Gemini Vision chat for accessibility scene descriptions."""

    _model: str = ''
    _client: genai.Client
    _system_prompt: str = ''
    _prompt: str = ''

    def __init__(self, provider: str, connConfig: dict[str, Any], bag: dict[str, Any]):
        """Initialize the Gemini Vision accessibility chat instance."""
        super().__init__(provider, connConfig, bag)
        config = Config.getNodeConfig(provider, connConfig)

        self._model = config.get('model', 'gemini-2.5-flash')
        api_key = config.get('apikey')

        # Get accessibility-specific config
        hazard_priority = config.get('accessibility.prioritizeHazards', 'high')
        spatial_format = config.get('accessibility.spatialFormat', 'clock')

        # Build system prompt with config modifiers
        self._system_prompt = (
            config.get('accessibility.systemPrompt')
            or config.get('systemPrompt')
            or DEFAULT_SYSTEM_PROMPT
        )
        self._system_prompt += HAZARD_PROMPTS.get(hazard_priority, '')
        self._system_prompt += SPATIAL_PROMPTS.get(spatial_format, '')

        self._prompt = (
            config.get('accessibility.prompt')
            or config.get('prompt')
            or DEFAULT_PROMPT
        )

        if not api_key:
            raise ValueError(
                'Missing Google AI API key. Get one at https://aistudio.google.com/apikey'
            )

        # Validate the API key format
        if api_key.startswith('sk-'):
            raise ValueError(
                'Invalid API key format. This appears to be an OpenAI key. '
                'Please provide a Google AI API key.'
            )

        try:
            self._client = genai.Client(api_key=api_key)
        except Exception as e:
            raise ValueError(f'Failed to initialize Google AI client: {e!s}') from e

        self._modelTotalTokens = config.get('modelTotalTokens', 1048576)
        bag['chat'] = self

    @property
    def prompt(self) -> str:
        """Get the current analysis prompt."""
        return self._prompt

    def getTotalTokens(self) -> int:
        """Get the total token limit for the current model."""
        return self._modelTotalTokens

    def getTokens(self, value: str) -> int:
        """Approximate token count (4 chars per token heuristic)."""
        if not value.strip():
            return 0
        return len(value) // 4

    def _format_user_error(self, error_msg: str) -> str:
        """Convert API error messages to user-friendly format."""
        error_lower = error_msg.lower()
        if any(phrase in error_lower for phrase in ['unauthorized', 'invalid api key', 'authentication', 'api_key']):
            return 'Authentication failed. Please check your Google AI API key.'
        if any(phrase in error_lower for phrase in ['rate limit', 'too many requests', '429', 'quota']):
            return 'Rate limit exceeded. Please wait a moment before trying again.'
        if any(phrase in error_lower for phrase in ['invalid input', 'bad request', '400']):
            return 'Invalid input. Please check your image format and prompt.'
        if any(phrase in error_lower for phrase in ['model not found', 'unavailable', 'not supported']):
            return f'Model \'{self._model}\' is currently unavailable. Please try a different model.'
        if any(phrase in error_lower for phrase in ['timeout', 'timed out']):
            return 'Request timed out. Please try again.'
        if any(phrase in error_lower for phrase in ['content policy', 'safety', 'blocked']):
            return 'Image was blocked by safety filters. Please try a different image.'
        return f'Google AI error: {error_msg}'

    def _shouldRetry(self, error: Exception) -> bool:
        """Determine if an error is retryable."""
        error_msg = str(error).lower()
        retryable = ['timeout', 'connection', '500', '502', '503', '504', 'internal server error']
        return any(phrase in error_msg for phrase in retryable)

    def chat(self, question: Question) -> Answer:
        """Send an image to Gemini for accessibility-focused scene description."""
        max_retries = 3
        base_delay = 1.0
        last_error = None

        # Extract image data from context
        image_data = None
        prompt_text = self._prompt
        if not question.context:
            raise ValueError('No image provided for accessibility description.')
        for context_item in question.context:
            if context_item.startswith(('data:image/', 'data:application/')):
                image_data = context_item
                break

        if question.questions:
            prompt_text = question.questions[0].text

        if not image_data:
            raise ValueError('No image provided for accessibility description.')

        # Parse the data URL outside the retry loop (deterministic)
        # Format: data:image/jpeg;base64,<data>
        try:
            header, b64_data = image_data.split(',', 1)
            mime_type = header.split(':')[1].split(';')[0]
            image_bytes = base64.b64decode(b64_data)
        except (ValueError, IndexError, base64.binascii.Error) as e:
            raise ValueError(
                'Malformed image data URL. Expected format: data:<mime>;base64,<data>'
            ) from e

        # Build request contents once (deterministic, no need to rebuild per retry)
        contents = [
            Content(
                role='user',
                parts=[
                    Part.from_bytes(data=image_bytes, mime_type=mime_type),
                    Part.from_text(text=prompt_text),
                ],
            )
        ]

        for attempt in range(max_retries + 1):
            try:
                response = self._client.models.generate_content(
                    model=self._model,
                    contents=contents,
                    config={
                        'system_instruction': self._system_prompt,
                        'temperature': 0.3,
                        'max_output_tokens': 1024,
                    },
                )

                answer = Answer(expectJson=question.expectJson)
                answer.setAnswer(response.text)
                return answer

            except Exception as e:
                last_error = e
                if attempt < max_retries and self._shouldRetry(e):
                    delay = base_delay * (2 ** attempt)
                    time.sleep(delay)
                    continue
                break

        user_friendly_error = self._format_user_error(str(last_error))
        raise AccessibilityVisionError(user_friendly_error) from last_error
