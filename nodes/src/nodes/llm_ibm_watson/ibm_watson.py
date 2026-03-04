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
from ibm_watsonx_ai import Credentials
from ibm_watsonx_ai.foundation_models import ModelInference
from ibm_watsonx_ai.foundation_models.schema import TextChatParameters


class Chat(ChatBase):
    """
    IBM Watson chat class.
    """

    _llm: ModelInference

    def __init__(self, provider: str, connConfig: Dict[str, Any], bag: Dict[str, Any]):
        """
        Initialize the IBM Watson chat instance.

        Args:
            provider (str): The provider identifier (e.g., "ibm_watson")
            connConfig (Dict[str, Any]): Connection configuration containing API credentials
                Expected keys:
                - apikey: IBM Watson API key
                - location: IBM Watson location/region
                - model: IBM Watson model ID
                - project_id: IBM Watson project ID
            bag (Dict[str, Any]): Shared state bag for storing chat instance

        Raises:
            ValueError: If required configuration is missing or invalid
        """
        super().__init__(provider, connConfig, bag)

        # Get the configuration
        config = Config.getNodeConfig(provider, connConfig)

        location = config.get('location')
        if 'Select Location' in location:
            raise ValueError('Please select a location.')
        url = f'https://{location}.ml.cloud.ibm.com'

        api_key = config.get('apikey')
        if not api_key:
            raise ValueError('IBM Watson API key is required.')

        credentials = Credentials(url=url, api_key=api_key)

        model_id = config.get('model')
        if not model_id:
            raise ValueError('IBM Watson model ID is required.')

        project_id = config.get('project_id')
        if not project_id:
            raise ValueError('IBM Watson project ID is required.')

        params = TextChatParameters(temperature=1)

        self._llm = ModelInference(model_id=model_id, credentials=credentials, project_id=project_id, params=params)

        # Save our chat class into the bag
        bag['chat'] = self

    def _chat(self, prompt: str) -> str:
        """
        Send prompt to IBM Watson and receive response.

        This method is called by the base class to handle the actual
        communication with the IBM Watson API.

        Args:
            prompt (str): The complete prompt to send to the model

        Returns:
            str: The generated text response from the model
        """
        if not prompt:
            raise ValueError('Prompt is empty.')

        messages = [{'role': 'user', 'content': prompt}]

        response = self._llm.chat(messages=messages)

        # Gets the text from response
        message = response['choices'][0]['message']['content']

        if not message:
            raise ValueError('Response is empty.')

        return message

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
