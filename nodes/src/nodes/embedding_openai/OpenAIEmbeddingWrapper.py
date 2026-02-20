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

"""
This is the common embedding module.
"""

# We now have real requirements, so load them before we start
# loading our driver
import os
from depends import depends

requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
depends(requirements)

# Load what we need
from rocketlib import debug
from typing import List, Dict, Any

from langchain_openai import OpenAIEmbeddings
from ai.common.config import Config
from ai.common.embedding import EmbeddingBase
from ai.common.schema import Doc, Question


class OpenAIEmbeddingWrapper(EmbeddingBase):
    """
    The embedding class controls the conversion of a piece of text into a vector. This can be a query or a set of document chunks.
    """

    _model: str = ''
    _vectorSize: int = 0
    _tokenSize: int = 0
    _embedding: OpenAIEmbeddings | None = None

    def __init__(self, provider: str, connConfig: Dict[str, Any], bag: Dict[str, Any]):
        """
        Construct OpenAI embedding wrapper.
        """
        # Init the base
        super().__init__(provider, connConfig, bag)

        # Get the nodes configuration
        config = Config.getNodeConfig(provider, connConfig)

        # Get the model from our section
        openai_api_key = config.get('apikey')
        self._model = config.get('model')

        self._embedding = OpenAIEmbeddings(openai_api_key=openai_api_key, model=self._model)

        # Check it
        if self._embedding is None:
            raise Exception(f'Could not instantiate embedding model ${self._model}')

        # Set the vector size
        self._updateVectorSize()

        # Get the max tokens
        self._tokenSize = self._embedding.embedding_ctx_length

        # Output some debug info
        debug(f'    Embedding model   : {self._model}')
        debug(f'    Embedding size    : {self._vectorSize}')
        debug(f'    Embedding tokens  : {self._tokenSize}')

    def getVectorSize(self) -> int:
        """
        Return the vector size of the embedding module.
        """
        # Return it
        return self._vectorSize

    def getMaximumTokens(self) -> int:
        """
        Return the maximum number of tokens in a request.
        """
        # Return it
        return self._tokenSize

    # Encode the given string return a list of vectors
    def encodeQuestion(self, question: Question) -> List:
        """
        Encode the given question into a vector and return the vector as an array of floats.
        """
        # For each question
        for q in question.questions:
            # Get embeddings and save them
            q.embedding = self._embedding.embed_query(q.text)
            q.embedding_model = self._model

    def encodeChunks(self, chunks: List[Doc]) -> None:
        """
        Encode the given document chunks into a vector and place it in the embedding field of the document.
        """
        # This happens if the document is empty
        if not chunks:
            return

        # Extract page contents
        embeddings = [chunk.page_content for chunk in chunks]
        # Get the embeddings
        array_vectors = self._embedding.embed_documents(embeddings)

        # Store the embeddings
        for chunk, vector in zip(chunks, array_vectors):
            chunk.embedding_model = self._model
            chunk.embedding = vector

    def _updateVectorSize(self) -> None:
        """
        Update the vector size.

        There is no direct way to get the vector size from the model
        It could be achieved by either doing vectorization of a simple sentence, or
        by setting vector size depending on the model name.
        Current implmentation uses the first approach.
        """
        if not self._vectorSize:
            self._vectorSize = len(self._embedding.embed_query('dummy'))
