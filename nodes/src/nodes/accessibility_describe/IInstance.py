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

from .IGlobal import IGlobal
from nodes.llm_base import IInstanceGenericLLM
from rocketlib import AVI_ACTION


class IInstance(IInstanceGenericLLM):
    """Instance handler for the Accessibility Scene Description node.

    Accepts image input and produces an accessibility-optimized text description
    designed for blind and visually impaired users. The description includes
    spatial layout (clock positions), text/sign content, potential hazards,
    and contextual information prioritized by safety relevance.
    """

    IGlobal: IGlobal

    def __init__(self):  # noqa: D107
        super().__init__()
        self.image_data: bytearray | None = None

    def writeImage(self, action: int, mimeType: str, buffer: bytes):
        # Begin: initialize the image buffer
        if action == AVI_ACTION.BEGIN:
            self.image_data = bytearray()
            return self.preventDefault()

        # Write: append image chunks
        if action == AVI_ACTION.WRITE:
            if self.image_data is None:
                self.image_data = bytearray()
            self.image_data += buffer
            return self.preventDefault()

        # End: process the complete image
        if action == AVI_ACTION.END:
            if not self.image_data:
                return self.preventDefault()

            from ai.common.schema import Question
            import base64

            try:
                question = Question()

                # Convert image bytes to base64 data URL
                image_base64 = base64.b64encode(bytes(self.image_data)).decode('utf-8')
                image_data_url = f'data:{mimeType};base64,{image_base64}'

                # Add the image as context for the vision model
                question.addContext(image_data_url)

                # Add the accessibility analysis prompt
                question.addQuestion(self.IGlobal.chat.prompt)

                # Call the vision model and get the accessibility description
                answer = self.IGlobal.chat.chat(question)

                # Emit the description as text output
                self.instance.writeText(answer.getText())
            finally:
                # Always clean up to prevent stale data on next invocation
                self.image_data = None

            return self.preventDefault()

        return None
