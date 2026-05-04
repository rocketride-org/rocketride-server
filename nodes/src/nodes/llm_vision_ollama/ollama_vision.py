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

import time
from typing import Any, Dict
from langchain_openai import ChatOpenAI
from ai.common.schema import Answer, Question
from ai.common.chat import ChatBase
from ai.common.config import Config
from rocketlib import warning


class Chat(ChatBase):
    """Ollama Vision chat bot using open-source multimodal models."""

    _llm: ChatOpenAI
    _system_prompt: str = ''
    _prompt: str = ''
    _serverbase: str = ''

    def __init__(self, provider: str, connConfig: Dict[str, Any], bag: Dict[str, Any]):
        """Initialize the Ollama Vision chat instance."""
        super().__init__(provider, connConfig, bag)

        config = Config.getNodeConfig(provider, connConfig)

        serverbase = config.get('serverbase', 'http://localhost:11434/v1')
        # Normalize serverbase to end with /v1
        if not serverbase.rstrip('/').endswith('/v1'):
            serverbase = serverbase.rstrip('/') + '/v1'
        self._serverbase = serverbase

        self._system_prompt = config.get('vision.systemPrompt') or config.get('systemPrompt') or ''
        self._prompt = config.get('vision.prompt') or config.get('prompt') or ''

        bag['chat'] = self

    def _format_user_error(self, error_msg: str) -> str:
        """Convert API error messages to user-friendly format."""
        error_lower = error_msg.lower()
        if any(
            p in error_lower for p in ['connection refused', 'connection error', 'failed to connect', 'cannot connect']
        ):
            return f'Cannot connect to Ollama server. Is Ollama running? (tried: {self._serverbase})'
        if any(p in error_lower for p in ['model not found', 'no such model', '404']):
            return f"Model '{self._model}' is not loaded in Ollama. Run: ollama pull {self._model}"
        if any(p in error_lower for p in ['rate limit', 'too many requests', '429']):
            return 'Too many requests to Ollama. Please wait a moment and try again.'
        if any(p in error_lower for p in ['internal server error', '500', 'service unavailable']):
            return 'Ollama returned a server error. Please check the Ollama logs.'
        if any(p in error_lower for p in ['timeout', 'timed out']):
            return f"Vision request timed out. The model '{self._model}' may need more time — please try again."
        if any(p in error_lower for p in ['image', 'vision', 'multimodal']):
            return (
                'Image processing error. Please check that your image is in a supported format (JPEG, PNG, GIF, WEBP).'
            )
        return f'Ollama Vision error: {error_msg}'

    def chat(self, question: Question) -> Answer:
        """Send a vision request to Ollama and get the response."""
        from langchain_core.messages import HumanMessage, SystemMessage

        # Extract image data URL from context
        image_data = None
        for ctx in question.context:
            if ctx.startswith(('data:image/', 'data:application/')):
                image_data = ctx
                break

        if not image_data:
            raise ValueError('No image data found in question context.')

        # Use configured prompt, or fall back to question text
        prompt_text = self._prompt or (question.questions[0].text if question.questions else None)
        if not prompt_text:
            prompt_text = 'Describe this image.'

        # Build multimodal messages
        messages = []
        if self._system_prompt:
            messages.append(SystemMessage(content=self._system_prompt))
        messages.append(
            HumanMessage(
                content=[
                    {'type': 'text', 'text': prompt_text},
                    {'type': 'image_url', 'image_url': {'url': image_data}},
                ]
            )
        )

        # Retry loop with exponential backoff
        max_retries = 1
        base_delay = 1.0
        last_error = None
        hard_timeout = 30

        for attempt in range(max_retries + 1):
            try:
                result = [None]
                exc = [None]

                # Fresh client per attempt — avoids exhausting the shared HTTP connection pool
                # when daemon threads from prior timed-out attempts are still holding connections
                llm = ChatOpenAI(
                    model=self._model,
                    base_url=self._serverbase,
                    api_key='ollama',
                    temperature=0,
                    max_tokens=self._modelOutputTokens,
                )

                def _invoke():
                    try:
                        result[0] = llm.invoke(messages)
                    except Exception as e:
                        exc[0] = e

                import threading

                t = threading.Thread(target=_invoke, daemon=True)
                t.start()
                t.join(timeout=hard_timeout)
                if t.is_alive():
                    warning(
                        f'Ollama Vision: inference timed out after {hard_timeout}s (attempt {attempt + 1}/{max_retries + 1}) — daemon thread still running'
                    )
                    raise TimeoutError(f'Vision inference timed out after {hard_timeout}s (attempt {attempt + 1})')
                if exc[0]:
                    raise exc[0]

                response = result[0]
                answer = Answer(expectJson=question.expectJson)
                answer.setAnswer(response.content)
                return answer
            except Exception as e:
                last_error = e
                if attempt < max_retries and self.is_retryable_error(e):
                    delay = base_delay * (2**attempt)
                    time.sleep(delay)
                    continue
                break

        raise Exception(self._format_user_error(str(last_error)))
