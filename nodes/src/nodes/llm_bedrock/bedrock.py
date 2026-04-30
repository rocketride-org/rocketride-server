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

"""
Bedrock binding for the ChatLLM.
"""

from typing import Any, Dict
from ai.common.chat import ChatBase
from ai.common.config import Config
from langchain_aws import ChatBedrock


class Chat(ChatBase):
    """
    Create a Bedrock chat bot.
    """

    _llm: ChatBedrock

    def __init__(self, provider: str, connConfig: Dict[str, Any], bag: Dict[str, Any]):
        """
        Initialize the Bedrock chat bot.
        """
        # Init the base
        super().__init__(provider, connConfig, bag)

        # Get the nodes configuration
        config = Config.getNodeConfig(provider, connConfig)

        # Get the AWS access Key, don't save it
        accessKey = config.get('accessKey')

        # Get the AWS access Key, don't save it
        secretKey = config.get('secretKey')

        # Get the AWS region, save it
        self.region = config.get('region')

        # Setup
        model_prefix = 'us.'
        if self.region[:2] == 'eu':
            model_prefix = 'eu.'
        elif self.region[:2] == 'ap':
            model_prefix = 'apac.'

        # Get the llm
        self._llm = ChatBedrock(
            model=model_prefix + self._model,
            aws_access_key_id=accessKey,
            aws_secret_access_key=secretKey,
            region=self.region,
            temperature=0,
            max_tokens=self._modelOutputTokens,
        )

        # Save our chat class into the bag
        bag['chat'] = self
