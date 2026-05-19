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
Cohere Rerank client wrapper for the RocketRide pipeline.
"""

from typing import Any, Dict, List, Optional
from cohere import ClientV2 as CohereClient
from cohere.errors import BadRequestError, UnauthorizedError, TooManyRequestsError, InternalServerError


# ---------------------------------------------------------------------------
# Custom exception hierarchy for circuit breaker compatibility.
# The class names contain 'RateLimit', 'Authentication', etc. so that
# retry/circuit-breaker heuristics that inspect type(exc).__name__ can
# correctly classify them.
# ---------------------------------------------------------------------------


class RerankError(Exception):
    """Base error for rerank operations."""

    pass


class RerankAuthenticationError(RerankError):
    """Non-retryable: Invalid API key."""

    pass


class RerankRateLimitError(RerankError):
    """Retryable: Rate limit exceeded."""

    pass


class RerankBadRequestError(RerankError):
    """Non-retryable: Invalid request parameters."""

    pass


class RerankServerError(RerankError):
    """Retryable: Server-side error."""

    pass


def _coerce_top_n(value: Any) -> int:
    """Validate top_n and coerce numeric values to int.

    Accepts int or float (excluding bool, which is an int subclass) and
    rejects floats that are not whole numbers (e.g. 2.5). This lets JSON
    callers pass ``5.0`` while still rejecting fractional values.
    """
    # bool is a subclass of int; reject it explicitly so True/False don't
    # silently coerce to 1/0.
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f'top_n must be an integer >= 1, got {value!r}')
    if isinstance(value, float):
        if not value.is_integer():
            raise ValueError(f'top_n must be an integer >= 1, got {value!r}')
        value = int(value)
    if value < 1:
        raise ValueError(f'top_n must be an integer >= 1, got {value!r}')
    return value


def _validate_min_score(value: Any) -> float:
    """Validate min_score is a number in [0.0, 1.0], excluding bool."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f'min_score must be a number between 0.0 and 1.0, got {value!r}')
    if not (0.0 <= value <= 1.0):
        raise ValueError(f'min_score must be a number between 0.0 and 1.0, got {value!r}')
    return float(value)


class RerankClient:
    """
    Wraps the Cohere Rerank API for use in RocketRide pipelines.
    """

    _client: CohereClient
    _model: str

    def __init__(self, logicalType: str, config: Dict[str, Any], bag: Dict[str, Any]):
        """
        Initialize the Cohere rerank client.

        Args:
            logicalType: The logical type of the node.
            config: Configuration dictionary containing API key, model, etc.
            bag: Shared bag for cross-node communication.
        """
        self._logicalType = logicalType
        self._model = config.get('model', 'rerank-english-v3.0')
        if not isinstance(self._model, str) or not self._model.strip():
            raise ValueError('Cohere model name is required')
        self._model = self._model.strip()

        raw_top_n = config.get('top_n', 5)
        self._top_n = _coerce_top_n(raw_top_n)

        raw_min_score = config.get('min_score', 0.0)
        self._min_score = _validate_min_score(raw_min_score)

        apikey = config.get('apikey', '')
        if not isinstance(apikey, str) or not apikey.strip():
            raise ValueError('Cohere API key is required')

        self._client = CohereClient(api_key=apikey.strip())

    def rerank(
        self, query: str, documents: List[str], top_n: Optional[int] = None, model: Optional[str] = None
    ) -> List[Dict[str, Any]]:
        """
        Rerank a list of documents by relevance to the given query.

        Args:
            query: The query to rank documents against.
            documents: List of document text strings.
            top_n: Number of top results to return. Defaults to configured value.
            model: Cohere rerank model to use. Defaults to configured value.

        Returns:
            List of dicts with keys: index, relevance_score, document.

        Raises:
            ValueError: If documents list is empty or query is empty.
            Exception: On Cohere API errors (auth, rate limit, server).
        """
        if not isinstance(query, str) or not query.strip():
            raise ValueError('Query must not be empty')
        query = query.strip()

        if not documents:
            raise ValueError('Documents list must not be empty')
        normalized_documents: List[str] = []
        for document in documents:
            if not isinstance(document, str) or not document.strip():
                raise ValueError('Documents must contain non-empty strings')
            normalized_documents.append(document.strip())
        documents = normalized_documents

        effective_top_n = _coerce_top_n(top_n) if top_n is not None else self._top_n
        if model is not None:
            if not isinstance(model, str) or not model.strip():
                raise ValueError('Model must not be empty')
            effective_model = model.strip()
        else:
            effective_model = self._model

        try:
            response = self._client.rerank(
                model=effective_model,
                query=query,
                documents=documents,
                top_n=effective_top_n,
            )
        except UnauthorizedError as e:
            raise RerankAuthenticationError(f'Invalid Cohere API key: {e}') from e
        except TooManyRequestsError as e:
            raise RerankRateLimitError(f'Cohere rate limit exceeded: {e}') from e
        except BadRequestError as e:
            raise RerankBadRequestError(f'Invalid rerank request: {e}') from e
        except InternalServerError as e:
            raise RerankServerError(f'Cohere server error: {e}') from e
        except Exception as e:
            raise RerankServerError(f'Unexpected Cohere error: {e}') from e

        return [
            {
                'index': result.index,
                'relevance_score': result.relevance_score,
                'document': documents[result.index],
            }
            for result in response.results
        ]

    def rerank_with_threshold(
        self,
        query: str,
        documents: List[str],
        top_n: Optional[int] = None,
        min_score: Optional[float] = None,
        model: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        """
        Rerank documents and filter by minimum relevance score.

        Args:
            query: The query to rank documents against.
            documents: List of document text strings.
            top_n: Number of top results to return before filtering.
            min_score: Minimum relevance score threshold (0.0-1.0).
            model: Cohere rerank model to use.

        Returns:
            List of dicts above the min_score threshold, sorted by relevance.
        """
        effective_min_score = _validate_min_score(min_score) if min_score is not None else self._min_score

        results = self.rerank(query=query, documents=documents, top_n=top_n, model=model)

        if effective_min_score > 0.0:
            results = [r for r in results if r['relevance_score'] >= effective_min_score]

        return results
