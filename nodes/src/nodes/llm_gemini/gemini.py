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

from typing import Any, Dict
from ai.common.chat import ChatBase
from ai.common.config import Config
from google import genai


class Chat(ChatBase):
    """
    Google GenAI chat class supporting both Gemini Developer API and Vertex AI.

    This class provides a standardized interface for interacting with Google's Gemini
    models through the genai library. It inherits from ChatBase and implements
    the necessary methods for chat functionality.

    Attributes:
        _client (genai.Client): The Google GenAI client instance for API communication

    Example:
        >>> chat = Chat(provider='gemini', connConfig={'apikey': 'your-api-key'}, bag={})
        >>> response = chat._chat('Hello, how are you?')
    """

    _client: genai.Client

    def __init__(self, provider: str, connConfig: Dict[str, Any], bag: Dict[str, Any]):
        """
        Initialize the Gemini chat bot.

        Args:
            provider (str): The provider identifier (e.g., "gemini")
            connConfig (Dict[str, Any]): Connection configuration containing API credentials
                Expected keys:
                - apikey: Google GenAI API key
            bag (Dict[str, Any]): Shared state bag for storing chat instance

        Raises:
            KeyError: If required configuration keys are missing
            ValueError: If API key is invalid or empty
        """
        super().__init__(provider, connConfig, bag)

        # Retrieve and validate configuration
        config = Config.getNodeConfig(provider, connConfig)
        api_key = config.get('apikey')

        # API key validation logic
        if not api_key or not api_key.startswith('AI'):
            raise ValueError('Invalid Gemini API key format... Please check your API key.')

        self._modelTotalTokens = config.get('modelTotalTokens', 8192)

        # Initialize the Google GenAI client
        self._client = genai.Client(api_key=api_key)

        # Store chat instance in shared bag for access by other components
        bag['chat'] = self

        """
        Note: For future refactor, we can consolidate Vertex AI support.
        The google-genai library supports Vertex AI through the same client:
        
        client = genai.Client(
            vertexai=True, 
            project='your-project-id', 
            location='us-central1'
        )
        
        This would allow us to remove the separate Vertex Node implementation
        and use a unified interface for both Developer API and Vertex AI.
        """

    def getTokens(self, value: str) -> int:
        """
        Estimate the number of tokens in a given text string.

        This is a simplified token estimation that assumes approximately 0.75 tokens
        per word. For more accurate token counting, consider using the model's
        built-in tokenizer if available.

        Args:
            value (str): The text string to estimate tokens for

        Returns:
            int: Estimated number of tokens

        Note:
            This is an approximation. Different models may have different
            tokenization schemes. For production use, consider using the
            model's native token counting method if available.
        """
        # Simple approximation: ~0.75 tokens per word
        word_count = len(value.split())
        return int(word_count / 0.75)

    def _chat(self, prompt: str) -> str:
        """
        Send a chat prompt to the Gemini model and return the response.

        This method handles the core chat functionality by sending the prompt
        to the configured Gemini model and returning the generated text response.

        Args:
            prompt (str): The user's input prompt/message

        Returns:
            str: The model's text response

        Raises:
            Exception: If the API call fails or returns an error
            AttributeError: If the model is not properly configured

        Note:
            This method assumes self._model is set by the parent class.
            The model should be a valid Gemini model identifier (e.g., 'gemini-pro').
        """
        # Generate content using the configured model
        response = self._client.models.generate_content(model=self._model, contents=prompt)

        # Extract and return the text response
        return response.text
