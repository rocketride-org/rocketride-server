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

from rocketlib import IInstanceBase
from rocketlib import AVI_ACTION
from .IGlobal import IGlobal


class IInstance(IInstanceBase):
    # Reference to a global instance providing shared functionality.
    IGlobal: IGlobal

    # Raw image data
    image_data: bytearray = None

    def writeImage(self, action: int, mimeType: str, buffer: bytes):
        # Handle AVI_BEGIN action
        if action == AVI_ACTION.BEGIN:
            self.image_data = bytearray()

        # Handle AVI_WRITE action (appending chunks of the image)
        elif action == AVI_ACTION.WRITE:
            self.image_data += buffer  # Append the chunk to the existing image data

        # Handle AVI_END action (finalizing the image processing)
        elif action == AVI_ACTION.END:
            # Preprocess it
            mimeType, image = self.IGlobal.process(mimeType, bytes(self.image_data))

            # Release the orginal image
            self.image_data = None

            # Output the image to the next pipe
            self.instance.writeImage(AVI_ACTION.BEGIN, mimeType)
            self.instance.writeImage(AVI_ACTION.WRITE, mimeType, image)
            self.instance.writeImage(AVI_ACTION.END, mimeType)

        # We are re-writing the image, so don't do the default
        return self.preventDefault()
