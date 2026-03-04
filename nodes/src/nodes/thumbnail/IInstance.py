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

from rocketlib import IInstanceBase, AVI_ACTION, Entry
from ai.common.schema import Doc, DocMetadata
from ai.common.image import ImageProcessor
from .IGlobal import IGlobal


class IInstance(IInstanceBase):
    """
    An instance-level class handling image data processing for each opened object.

    This class processes streamed image data in chunks via the writeImage method,
    accumulates the data, converts it to an image, generates a thumbnail, and
    then forwards the processed documents or images to appropriate listeners.
    """

    IGlobal: IGlobal  # Reference to the global singleton instance

    def open(self, object: Entry):
        """
        Open a new object for processing.

        Initializes/reset variables related to image chunk handling.

        Args:
            object (Entry): The data entry or object to process.
        """
        self.chunkId = 0  # Initialize chunk counter
        self.image_data = None  # Reset accumulated raw image data buffer

    def writeImage(self, action: int, mimeType: str, buffer: bytes):
        """
        Handle image data chunks streamed in multiple steps.

        Supports three primary actions:
        - AVI_ACTION.BEGIN: Initialize a new bytearray to accumulate image data.
        - AVI_ACTION.WRITE: Append incoming image data chunks to the buffer.
        - AVI_ACTION.END: Finalize the image, generate thumbnails, encode, and
          pass it on to document or image listeners.

        Args:
            action (int): The current action in the stream (BEGIN, WRITE, END).
            mimeType (str): The MIME type of the image data (e.g., 'image/png').
            buffer (bytes): The image data chunk to process.

        Returns:
            bool: True if the default processing should be prevented (handled internally).
        """
        # Handle the start of image data streaming
        if action == AVI_ACTION.BEGIN:
            self.image_data = bytearray()  # Initialize buffer to accumulate chunks
            return self.preventDefault()  # Signal to prevent further default handling

        # Handle incoming chunks of image data to append
        elif action == AVI_ACTION.WRITE:
            self.image_data += buffer  # Append the chunk to the buffer
            return self.preventDefault()  # Prevent default handling again

        # Handle the end of image data streaming and process the full image
        elif action == AVI_ACTION.END:
            # Load the full image from the accumulated byte buffer
            image = ImageProcessor.load_image_from_bytes(self.image_data)

            # Generate a 128x128 pixel thumbnail from the image
            thumbnail = ImageProcessor.get_thumbnail(image)

            # If there's a listener for document processing, create and emit a Doc
            if self.instance.hasListener('documents'):
                # Encode the thumbnail image as a base64 string for embedding
                image_str = ImageProcessor.get_base64(thumbnail)

                # Prepare document metadata
                metadata = DocMetadata(
                    self,
                    chunkId=self.chunkId,
                    isTable=False,
                    tableId=0,
                    isDeleted=False,
                )

                # Create the document object with the image data and metadata
                doc = Doc(type='Image', page_content=image_str, metadata=metadata)

                # Wrap the single document in a list as expected by downstream handlers
                documents = [doc]

                # Emit the document(s) for further processing in the pipeline
                self.instance.writeDocuments(documents)

                # Reset image data after processing is complete
                self.image_data = b''

            # If there's an image listener, pass the image bytes directly as well
            if self.instance.hasListener('image'):
                # Convert thumbnail image to raw PNG bytes
                image_bytes = ImageProcessor.get_bytes(thumbnail)

                # Write the image data in three steps to the image listener
                self.instance.writeImage(AVI_ACTION.BEGIN, mimeType)
                self.instance.writeImage(AVI_ACTION.WRITE, mimeType, image_bytes)
                self.instance.writeImage(AVI_ACTION.END, mimeType)

            # Clear the image data to free memory
            self.image_data = None

            # Indicate that we have fully handled the image stream
            return self.preventDefault()
