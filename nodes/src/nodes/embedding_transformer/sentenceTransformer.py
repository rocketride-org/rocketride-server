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
from rocketlib import debug, monitorStatus
from typing import List, Dict, Any

# Output monitor status to show what we are doing
monitorStatus('Loading transformers')

# Load all the heavy weight stuff
from numpy import ndarray
from ai.common.models import SentenceTransformer
from ai.common.config import Config
from ai.common.embedding import EmbeddingBase
from ai.common.schema import Doc, Question

# Output monitor status to show loading finished
monitorStatus('Loading transformers complete')


class Embedding(EmbeddingBase):
    """The embedding class controls the conversion of a piece of text into a vector.

    This can be a query or a set of document chunks.
    """

    _model: str = ''
    _modelFolder: str = ''
    _vectorSize: int = 0
    _tokenSize: int = 0
    _embedding: SentenceTransformer | None = None
    _document_prefix: str = ''
    _query_prefix: str = ''

    def __init__(self, provider: str, connConfig: Dict[str, Any], bag: Dict[str, Any]):
        """Initialize the Embedding instance with provider configuration."""
        # Init the base
        super().__init__(provider, connConfig, bag)

        # Get the nodes configuration
        config = Config.getNodeConfig(provider, connConfig)

        # Get the model from our section
        self._model = config.get('model')
        self._truncateDim = config.get('truncate_dim', None) or None
        self._document_prefix = config.get('document_prefix', '')
        self._query_prefix = config.get('query_prefix', '')

        # Create one
        monitorStatus('Loading model', self._model)
        self._embedding = SentenceTransformer(
            model_name_or_path=self._model,
            trust_remote_code=True,
            truncate_dim=self._truncateDim,
        )

        # Check it
        if self._embedding is None:
            raise Exception(f'Could not instantiate embedding model ${self._model}')

        # Get the vector size and max tokens
        self._vectorSize = self._embedding.get_sentence_embedding_dimension()
        self._tokenSize = self._embedding.max_seq_length

        # Output some debug info
        debug(f'    Embedding model   : {self._model}')
        debug(f'    Embedding size    : {self._vectorSize}')
        debug(f'    Embedding tokens  : {self._tokenSize}')

        # Clear the output, we are done loading
        monitorStatus('')

    def getVectorSize(self) -> int:
        """Return the vector size of the embedding module."""
        # Return it
        return self._vectorSize

    def getMaximumTokens(self) -> int:
        """Return the maximum number of tokens in a request."""
        # Return it
        return self._tokenSize

    # Encode the given string return a list of vectors
    def encodeQuestion(self, question: Question) -> List:
        """Given a string (document), encode the document into a vector.

        Return the vector as an array of floats.
        """
        # Encode all questions in one batch; encode(list) returns (N, dim), assign vectors[i] per question
        if not question.questions:
            return
        texts = [f'{self._query_prefix}{q.text}' for q in question.questions] if self._query_prefix else [q.text for q in question.questions]
        # Get the vectors
        vectors = self._embedding.encode(texts, show_progress_bar=False)
        # Check the return type
        if not isinstance(vectors, ndarray):
            raise Exception('Embedding is not an ndarray')
        # Save it
        for i, q in enumerate(question.questions):
            q.embedding = vectors[i].tolist()
            q.embedding_model = self._model

    def encodeChunks(self, chunks: List[Doc]) -> None:
        """Given a list of documents, encode the document into a vector.

        Place it in the embedding field of the document.
        """
        # This happens if the document is empty
        if not len(chunks):
            return

        # For each document, if specified
        embeddings: List[str] = []
        for chunk in chunks:
            embeddings.append(f'{self._document_prefix}{chunk.page_content}' if self._document_prefix else chunk.page_content)

        # Get the vectors
        array_vectors = self._embedding.encode(embeddings, show_progress_bar=False)

        # Save the embeddings
        for index in range(0, len(chunks)):
            # Save the embedding model and vectors as a list
            chunks[index].embedding_model = self._model
            chunks[index].embedding = array_vectors[index].tolist()
