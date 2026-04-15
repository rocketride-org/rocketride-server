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
    """Instance handler for the Anthropic Vision node."""

    IGlobal: IGlobal

    # Raw image data accumulated across AVI_WRITE chunks
    image_data: bytearray | None = None

    # Cached answer text from writeDocuments so writeImage can reuse it without
    # a second API call for the same frame. Cleared at AVI_ACTION.BEGIN so a
    # late-arriving writeDocuments from frame N cannot bleed into frame N+1.
    _cached_answer: str | None = None

    def writeImage(self, action: int, mimeType: str, buffer: bytes):
        """Handle AVI image protocol for streaming image frames."""
        if action == AVI_ACTION.BEGIN:
            self.image_data = bytearray()
            self._cached_answer = None
            return self.preventDefault()
        elif action == AVI_ACTION.WRITE:
            if self.image_data is None:
                raise RuntimeError('AVI protocol error: WRITE received before BEGIN')
            self.image_data += buffer
            return self.preventDefault()
        elif action == AVI_ACTION.END:
            if self.image_data is None:
                raise RuntimeError('AVI protocol error: END received while there is no data')

            if self._cached_answer is not None:
                # writeDocuments already called Claude for this frame — reuse the result.
                self.instance.writeText(self._cached_answer)
                self._cached_answer = None
            else:
                # Only the image lane is connected; call Claude directly.
                from ai.common.schema import Question
                import base64

                question = Question()
                image_base64 = base64.b64encode(bytes(self.image_data)).decode('utf-8')
                image_data_url = f'data:{mimeType};base64,{image_base64}'
                question.addContext(image_data_url)
                question.addQuestion(self.IGlobal._chat._prompt)

                answer = self.IGlobal._chat.chat(question)
                self.instance.writeText(answer.getText())

            self.image_data = None
            return self.preventDefault()

    def writeDocuments(self, documents: list[Doc]):
        """Process incoming image documents inline and emit vision model responses as text documents."""
        from ai.common.schema import Question

        for doc in documents:
            if doc.type != 'Image':
                warning(f'Anthropic Vision: skipping document with unexpected type "{doc.type}"')
                continue
            if not doc.page_content:
                warning('Anthropic Vision: skipping Image document with empty content')
                continue

            question = Question()
            # All Image doc producers (frame_grabber, thumbnail, embedding_image) normalize to PNG
            question.addContext(f'data:image/png;base64,{doc.page_content}')
            question.addQuestion(self.IGlobal._chat._prompt)

            try:
                answer = self.IGlobal._chat.chat(question)
            except Exception as e:
                warning(f'Anthropic Vision: inference failed for chunk {doc.metadata.chunkId}: {e}')
                continue

            answer_text = answer.getText()

            # Cache so writeImage can emit the same text without a second API call.
            self._cached_answer = answer_text

            self.instance.writeDocuments([Doc(type='Text', page_content=answer_text, metadata=doc.metadata)])

        # Prevent the original Image docs from flowing downstream.
        self.preventDefault()
