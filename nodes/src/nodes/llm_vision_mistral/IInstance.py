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

from .IGlobal import IGlobal
from nodes.llm_base import IInstanceGenericLLM
from rocketlib import AVI_ACTION


class IInstance(IInstanceGenericLLM):
    """Instance handler for the Mistral Vision AI node."""

    def __init__(self):
        """
        Initialize the IInstance class for the Mistral Vision AI node.
        """
        super().__init__()
        self.IGlobal = IGlobal()
        self.image_data = bytearray()

    def writeImage(self, action: int, mimeType: str, buffer: bytes):
        # Handle AVI_BEGIN action
        if action == AVI_ACTION.BEGIN:
            self.image_data = bytearray()
            return self.preventDefault()
        # Handle AVI_WRITE action (appending chunks of the image)
        elif action == AVI_ACTION.WRITE:
            self.image_data += buffer
            return self.preventDefault()
        # Handle AVI_END action (finalizing the image processing)
        elif action == AVI_ACTION.END:
            # Create a question object with the image data
            from ai.common.schema import Question

            question = Question()

            # Convert image bytes to base64 and add as context
            import base64

            image_base64 = base64.b64encode(bytes(self.image_data)).decode('utf-8')
            image_data_url = f'data:{mimeType};base64,{image_base64}'

            # Add the image as context
            question.addContext(image_data_url)

            # Add the prompt as a question
            question.addQuestion(self.IGlobal._chat._prompt)

            # Call the LLM and get the answer
            answer = self.IGlobal._chat.chat(question)

            # Send the answer to the pipeline as text
            self.instance.writeText(answer.getText())

            # Clear the image data
            self.image_data = None
            return self.preventDefault()
