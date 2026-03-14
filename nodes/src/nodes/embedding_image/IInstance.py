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

from typing import List
from rocketlib import IInstanceBase, AVI_ACTION
from ai.common.schema import Doc, DocMetadata
from ai.common.image import ImageProcessor
from .IGlobal import IGlobal


class IInstance(IInstanceBase):
    """
    IInstance manages instance-level processing of documents within the node.

    It relies on the global embedding instance provided by IGlobal to generate
    embeddings for documents, specifically handling image documents here.
    """

    IGlobal: IGlobal
    """
    Reference to the global context object of type IGlobal.

    This provides access to shared resources like the embedding model,
    initialized at the global lifecycle level.
    """

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._image_chunk_id = 0

    def writeDocuments(self, documents: List[Doc]):
        """
        Process and enrich a list of documents by generating embeddings for image documents.

        This method expects each document to be of type 'Image'. For each document:
        - It verifies the document type is 'Image'.
        - Decodes the base64-encoded PNG image content into a Pillow Image object.
        - Uses the global embedding instance to create an embedding vector from the image.
        - Assigns the embedding vector and the embedding model name back to the document.
        - Writes the enriched document(s) back to the instance's storage or pipeline.

        Args:
            documents (List[Doc]): List of document objects to process.

        Raises:
            ValueError: If a document is not of type 'Image'.
        """
        for doc in documents:
            # Validate that the document's type is 'Image'.
            # Embeddings are only supported for images in this method.
            if doc.type != 'Image':
                raise ValueError('Document type must be an "image"')

            # Decode the image from its base64-encoded string representation.
            # This produces a Pillow Image object suitable for embedding.
            image = ImageProcessor.load_image_from_base64(doc.page_content)

            # Generate embedding vectors for the image using the global embedding instance.
            vectors = self.IGlobal.embedding.create_image_embedding(image)

            # Assign the embedding vectors to the document as a list for serialization.
            doc.embedding = vectors if isinstance(vectors, list) else vectors.tolist()

            # Store the model name used for generating the embedding for traceability.
            doc.embedding_model = self.IGlobal.embedding.model_name

            # Write the enriched document back via the instance's writeDocuments method.
            # Wrapping the single document in a list to comply with the expected input type.
            self.instance.writeDocuments([doc])

    def writeImage(self, action: int, mimeType: str, buffer: bytes):
        # Handle AVI_BEGIN action
        if action == AVI_ACTION.BEGIN:
            self.image_data = bytearray()

        # Handle AVI_WRITE action (appending chunks of the image)
        elif action == AVI_ACTION.WRITE:
            self.image_data += buffer  # Append the chunk to the existing image data

        # Handle AVI_END action (finalizing the image processing)
        elif action == AVI_ACTION.END:
            # Convert the accumulated image data into an image
            image = ImageProcessor.load_image_from_bytes(self.image_data)

            # Base64 encode it
            image_str = ImageProcessor.get_base64(image)

            embedding = self.IGlobal.embedding.create_image_embedding(image)

            # Create the Doc object for the image (unique chunkId per image)
            metadata = DocMetadata(
                self,
                chunkId=self._image_chunk_id,
                isTable=False,
                tableId=0,
                isDeleted=False,
            )

            # Create a document
            doc = Doc(type='Image', page_content=image_str, metadata=metadata)

            # Save the embedding and model name to the document
            doc.embedding = embedding
            doc.embedding_model = self.IGlobal.embedding.model_name

            # Wrap the document in a list to comply with the expected input type
            documents = [doc]

            # Pass the documents to the next pipeline stage
            self.instance.writeDocuments(documents)

            # Clear the image data and increment chunk for next image
            self.image_data = None
            self._image_chunk_id += 1
