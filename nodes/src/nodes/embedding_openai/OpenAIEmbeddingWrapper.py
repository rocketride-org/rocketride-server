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
import threading

from rocketlib import debug
from typing import List, Dict, Any

from langchain_openai import OpenAIEmbeddings
from ai.common.schema import Doc, Question


class OpenAIEmbeddingWrapper:
    """
    The embedding class controls the conversion of a piece of text into a vector. This can be a query or a set of document chunks.

    The API key is the control's; the model is each call's. A LangChain
    ``OpenAIEmbeddings`` binds its model at construction (it builds no
    connection and windows long inputs by the model's token limit), so the
    wrapper keeps one per model a call has asked for, built on first use. The
    model selector lists nine models, which bounds the cache.
    """

    def __init__(self, provider: str, config: Dict[str, Any], bag: Dict[str, Any]):
        """
        Construct OpenAI embedding wrapper.

        Args:
            provider: The node's logical type.
            config: The control's resolved config (``IGlobal.config``): the required API key.
            bag: The endpoint bag.
        """
        # The key is a required leaf, so it is set
        self._apikey = config['apikey'].strip()
        self._lock = threading.Lock()  #: Guards the two maps below; held for a lookup, never for a request.
        self._building: Dict[str, threading.Lock] = {}  #: One build lock per model, so each is built once.
        self._models: Dict[str, Dict[str, Any]] = {}

    def _model(self, model: str) -> Dict[str, Any]:
        """
        The embedder of one model with its vector size and token limit, built on first use.

        The vector size has no API of its own, so the first use of a model embeds
        one short probe sentence (one request per model per control). The probe
        runs under that model's own build lock: concurrent first calls of one
        model build it once, and calls of a model already built never wait for
        another model's probe.

        Args:
            model: The call's OpenAI embedding model.

        Returns:
            ``{'embedding': OpenAIEmbeddings, 'vectorSize': int, 'tokenSize': int}``.
        """
        # Step 1: a built model is a lookup; otherwise take that model's build lock
        with self._lock:
            entry = self._models.get(model)
            if entry is not None:
                return entry
            building = self._building.setdefault(model, threading.Lock())

        # Step 2: build it once; a caller that waited here finds the first caller's entry
        with building:
            with self._lock:
                entry = self._models.get(model)
            if entry is None:
                embedding = OpenAIEmbeddings(openai_api_key=self._apikey, model=model)
                entry = {
                    'embedding': embedding,
                    'vectorSize': len(embedding.embed_query('dummy')),
                    'tokenSize': embedding.embedding_ctx_length,
                }
                with self._lock:
                    self._models[model] = entry

                # Output some debug info
                debug(f'    Embedding model   : {model}')
                debug(f'    Embedding size    : {entry["vectorSize"]}')
                debug(f'    Embedding tokens  : {entry["tokenSize"]}')
            return entry

    def getVectorSize(self, model: str) -> int:
        """
        Return the vector size of one model.
        """
        return self._model(model)['vectorSize']

    def getMaximumTokens(self, model: str) -> int:
        """
        Return the maximum number of tokens in a request to one model.
        """
        return self._model(model)['tokenSize']

    # Encode the given string return a list of vectors
    def encodeQuestion(self, question: Question, model: str) -> List:
        """
        Encode the given question into a vector with the call's model and return the vector as an array of floats.
        """
        embedding = self._model(model)['embedding']
        # For each question
        for q in question.questions:
            # Get embeddings and save them
            q.embedding = embedding.embed_query(q.text)
            q.embedding_model = model

    def encodeChunks(self, chunks: List[Doc], model: str) -> None:
        """
        Encode the given document chunks with the call's model and place each vector in the embedding field of the document.
        """
        # This happens if the document is empty
        if not chunks:
            return

        # Extract page contents
        embeddings = [chunk.page_content for chunk in chunks]
        # Get the embeddings
        array_vectors = self._model(model)['embedding'].embed_documents(embeddings)

        # Store the embeddings
        for chunk, vector in zip(chunks, array_vectors):
            chunk.embedding_model = model
            chunk.embedding = vector
