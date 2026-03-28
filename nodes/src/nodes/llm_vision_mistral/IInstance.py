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

from .IGlobal import IGlobal
from nodes.llm_base import IInstanceGenericLLM
from rocketlib import AVI_ACTION, warning
from ai.common.schema import Doc


class IInstance(IInstanceGenericLLM):
    """Instance handler for the Mistral Vision AI node."""

    IGlobal: IGlobal

    # Raw image data
    image_data: bytearray = None

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

    def writeDocuments(self, documents: list[Doc]):
        """Process incoming image documents and emit vision model responses as questions.

        Skips non-Image documents and documents with empty content, emitting a warning
        for each. Valid image documents are passed to the vision model and the resulting
        answer is forwarded to downstream listeners as a Question.

        Args:
            documents: List of Doc objects to process; only type 'Image' is handled.
        """
        from ai.common.schema import Question

        for doc in documents:
            if doc.type != 'Image':
                warning(f'Mistral Vision: skipping document with unexpected type "{doc.type}"')
                continue
            if not doc.page_content:
                warning('Mistral Vision: skipping Image document with empty content')
                continue

            question = Question()

            # page_content is base64-encoded PNG (frame grabber always outputs PNG)
            image_data_url = f'data:image/png;base64,{doc.page_content}'
            question.addContext(image_data_url)
            question.addQuestion(self.IGlobal._chat._prompt)

            try:
                answer = self.IGlobal._chat.chat(question)
            except Exception as e:
                warning(f'Mistral Vision: inference failed for chunk {doc.metadata.chunkId}: {e}')
                continue

            # Emit a text Doc preserving the original metadata (chunkId, time_stamp, etc.)
            self.instance.writeDocuments([Doc(type='Text', page_content=answer.getText(), metadata=doc.metadata)])
