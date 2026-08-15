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

import base64
from rocketlib import AVI_ACTION, Entry, IInstanceBase, warning
from ai.common.schema import Doc, DocMetadata
from ai.common.image import ImageProcessor
from ai.common.avi.descriptor import (
    descriptor_from_payload,
    attach_source,
    image_source_layer,
    forward_enriched_image,
    inherited_or_derived_name,
)
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
        self._source_descriptor = None  # Stream descriptor from the image BEGIN

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
            # BEGIN carries the stream descriptor (source provenance), not image bytes.
            self._source_descriptor = descriptor_from_payload(buffer)
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

                # Provenance chain: attach_source nests the frame's own source (the
                # video) under the frame layer. Keep the input frame's name.
                attach_source(metadata, self._source_descriptor)
                name = self._output_name()
                if name:
                    metadata.name = name

                # Create the document object with the image data and metadata
                doc = Doc(type='Image', page_content=image_str, metadata=metadata)

                # Emit the document(s) for further processing in the pipeline
                self.instance.writeDocuments([doc])
                self.chunkId += 1

                # Reset image data after processing is complete
                self.image_data = b''

            # If there's an image listener, pass the image bytes directly as well
            if self.instance.hasListener('image'):
                # Convert thumbnail image to raw PNG bytes
                image_bytes = ImageProcessor.get_bytes(thumbnail)

                # Enriched BEGIN carries the nested source chain + name. Bytes are always
                # PNG (get_bytes), so emit 'image/png', not the incoming mime.
                forward_enriched_image(
                    self.instance,
                    self._source_descriptor,
                    'image/png',
                    image_bytes,
                    width=thumbnail.width,
                    height=thumbnail.height,
                )

            # Clear the image data to free memory
            self.image_data = None

            # Indicate that we have fully handled the image stream
            return self.preventDefault()

    def _output_name(self):
        """The thumbnail's name: keep the input frame's name (it represents the same
        frame), falling back to the source stem for un-chained raw-image inputs.

        Returns:
            str: The name, or None when no source name is available.
        """
        return inherited_or_derived_name(self._source_descriptor, ext='png')

    def writeDocuments(self, documents: list[Doc]):
        """
        Process incoming image documents and emit thumbnailed versions.

        Accepts a list of Doc objects, skips any that are not Image type or lack
        content, generates a 128x128 thumbnail from the base64-encoded image, and
        forwards a new Doc with the thumbnail and original metadata preserved.

        Args:
            documents (list[Doc]): List of documents to process.
        """
        for doc in documents:
            if doc.type != 'Image':
                warning(f'Thumbnail: skipping document with unexpected type "{doc.type}"')
                continue
            if not doc.page_content:
                warning('Thumbnail: skipping Image document with empty content')
                continue

            try:
                image = ImageProcessor.load_image_from_base64(doc.page_content)
                thumbnail = ImageProcessor.get_thumbnail(image)
                thumbnail_base64 = ImageProcessor.get_base64(thumbnail)
            except Exception as e:
                warning(f'Thumbnail: failed to process chunk {doc.metadata.chunkId}: {e}')
                continue

            # Re-derive provenance on a copy (don't mutate the input). A frame Doc doesn't
            # self-describe, so synthesize its media layer from the decoded frame so it
            # matches the image lane, and nest the frame's existing source (the video).
            new_md = doc.metadata.model_copy()
            new_md.source = image_source_layer(
                size=len(base64.b64decode(doc.page_content)),
                width=image.width,
                height=image.height,
                stream_index=getattr(doc.metadata, 'chunkId', None),
                name=getattr(doc.metadata, 'name', None),
                prior_source=getattr(doc.metadata, 'source', None),
            )
            self.instance.writeDocuments([Doc(type='Image', page_content=thumbnail_base64, metadata=new_md)])

        self.preventDefault()
