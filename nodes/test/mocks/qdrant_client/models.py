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
Mock qdrant_client.models Module
================================

This module provides mock implementations of the data models used by the
qdrant_client library. These dataclasses mirror the real Qdrant models
to ensure API compatibility.

Implementing Mock Models:
-------------------------
When creating mock models for a new library:

1. ONLY IMPLEMENT WHAT'S NEEDED: Start with the models that the node code
   actually uses. You can add more later as tests reveal missing types.

2. USE DATACLASSES: For simple data containers, Python's @dataclass decorator
   provides automatic __init__, __repr__, and __eq__ with minimal boilerplate.

3. MATCH FIELD NAMES EXACTLY: The node code accesses attributes by name
   (e.g., point.payload, filter.must), so field names must match the real API.

4. ALLOW OPTIONAL FIELDS: Use Optional[T] = None for fields that aren't always
   provided. This prevents TypeErrors when the node code doesn't pass them.

5. DON'T IMPLEMENT METHODS: Mock models usually don't need the validation or
   transformation methods of the real models. Just store the data.

Finding What Models to Mock:
----------------------------
1. Run the test without mocks to see ImportError messages
2. Check the real library's documentation or source code
3. Look at how the node code uses the library (what it imports, accesses)
4. Start minimal and add types as tests fail
"""

from enum import Enum
from typing import List, Any, Optional
from dataclasses import dataclass


# =============================================================================
# Query Result Types
# =============================================================================
# These are returned by search/scroll operations


@dataclass
class ScoredPoint:
    """
    A point (vector) with its similarity score from a search operation.

    Returned by query_points() when performing semantic similarity search.
    The score indicates how similar this point's vector is to the query vector.

    Attributes:
        id: Unique identifier for this point (usually a UUID string)
        score: Similarity score (0.0 to 1.0 for cosine, varies for other metrics)
        payload: The associated metadata/content dict
        vector: The embedding vector (optional, only if with_vectors=True)
    """

    id: str
    score: float
    payload: Optional[dict] = None
    vector: Optional[List[float]] = None


@dataclass
class Record:
    """
    A point record returned by scroll operations (non-scored retrieval).

    Used by scroll() for paginated retrieval of points by filter conditions.
    Unlike ScoredPoint, there's no score since this isn't a similarity search.

    Attributes:
        id: Unique identifier for this point
        payload: The associated metadata/content dict
        vector: The embedding vector (optional)
    """

    id: str
    payload: Optional[dict] = None
    vector: Optional[List[float]] = None


# =============================================================================
# Point Storage Types
# =============================================================================
# These are used when inserting/upserting data


@dataclass
class PointStruct:
    """
    A complete point (document) to store in the vector database.

    This is the primary data structure for inserting data. It contains:
    - A unique ID (typically a UUID)
    - The embedding vector (list of floats from the embedding model)
    - The payload (metadata dict containing the actual document content)

    Attributes:
        id: Unique identifier for this point
        vector: The embedding vector (must match collection's vector size)
        payload: Metadata dict (e.g., {'meta': {...}, 'content': '...'})
    """

    id: str
    vector: List[float]
    payload: dict


# =============================================================================
# Filter Types
# =============================================================================
# These are used to build query filters for scroll() and query_points()


@dataclass
class Filter:
    """
    A composite filter with boolean logic.

    Filters can combine multiple conditions:
    - must: All conditions must match (AND logic)
    - should: At least one condition must match (OR logic)
    - must_not: None of the conditions can match (NOT logic)

    Example (from RocketRide store code):
        Filter(must=[
            FieldCondition(key='meta.objectId', match=MatchValue(value='doc-123'))
        ])

    Attributes:
        must: List of conditions that ALL must be true
        should: List of conditions where AT LEAST ONE must be true
        must_not: List of conditions that NONE can be true
    """

    must: Optional[List[Any]] = None
    should: Optional[List[Any]] = None
    must_not: Optional[List[Any]] = None


@dataclass
class FieldCondition:
    """
    A condition that checks a single field in the payload.

    The key uses dot notation for nested fields (e.g., 'meta.objectId').
    The match or range parameter specifies what to check.

    Attributes:
        key: Dot-notation path to the field (e.g., 'meta.nodeId')
        match: Match condition (MatchValue, MatchAny, or MatchText)
        range: Numeric range condition (Range)
    """

    key: str
    match: Optional[Any] = None
    range: Optional[Any] = None


@dataclass
class MatchValue:
    """
    Match a specific value exactly.

    Example: MatchValue(value='schema') matches if field == 'schema'
    """

    value: Any


@dataclass
class MatchAny:
    """
    Match any value in a list.

    Example: MatchAny(any=['doc-1', 'doc-2']) matches if field in ['doc-1', 'doc-2']

    The RocketRide store uses this to filter for specific objectIds when
    retrieving or deleting documents.
    """

    any: List[Any]


@dataclass
class MatchText:
    """
    Full-text search match.

    Example: MatchText(text='hello world') matches if field contains 'hello world'

    Note: Not implemented in the mock - would require text indexing.
    """

    text: str


@dataclass
class Range:
    """
    Numeric range condition.

    All fields are optional - use combinations for different range types:
    - Range(gte=0, lte=100): 0 <= value <= 100
    - Range(gt=0): value > 0
    - Range(lt=1.0): value < 1.0

    Attributes:
        gte: Greater than or equal
        lte: Less than or equal
        gt: Greater than (exclusive)
        lt: Less than (exclusive)
    """

    gte: Optional[float] = None
    lte: Optional[float] = None
    gt: Optional[float] = None
    lt: Optional[float] = None


# =============================================================================
# Search Configuration Types
# =============================================================================


@dataclass
class SearchParams:
    """
    Parameters for search algorithm configuration.

    Attributes:
        exact: If True, perform exact search instead of approximate (slower but precise)
    """

    exact: bool = False


@dataclass
class TextIndexParams:
    """
    Configuration for text field indexing.

    Used when creating a payload index on a text field to enable
    full-text search capabilities.

    Attributes:
        type: Index type (always "text" for text indexing)
        tokenizer: How to split text ("word", "whitespace", etc.)
        min_token_len: Minimum token length to index
        max_token_len: Maximum token length to index
        lowercase: Whether to lowercase tokens for case-insensitive search
    """

    type: str = 'text'
    tokenizer: str = 'word'
    min_token_len: int = 2
    max_token_len: int = 15
    lowercase: bool = True


# =============================================================================
# Enumeration-Like Types
# =============================================================================
# These mimic Qdrant's enum-like classes for type constants


class TextIndexType:
    """Constants for text index types."""

    TEXT = 'text'


class TokenizerType:
    """Constants for tokenizer types."""

    WORD = 'word'


class PayloadSchemaType:
    """
    Constants for payload field types used in indexing.

    When creating a payload index, you specify the field type so Qdrant
    knows how to index and query it efficiently.
    """

    KEYWORD = 'keyword'  # Exact string matching
    INTEGER = 'integer'  # Numeric integer values
    BOOL = 'bool'  # Boolean values


# =============================================================================
# Batch Operation Types
# =============================================================================
# These wrap operations for batch_update_points()


@dataclass
class DeleteOperation:
    """
    Wrapper for a delete operation in batch updates.

    Attributes:
        delete: A FilterSelector or PointsSelector specifying what to delete
    """

    delete: Any


@dataclass
class UpsertOperation:
    """
    Wrapper for an upsert (insert/update) operation in batch updates.

    Attributes:
        upsert: A PointsList containing the points to insert/update
    """

    upsert: Any


@dataclass
class FilterSelector:
    """
    Selects points by filter for delete operations.

    Attributes:
        filter: The Filter specifying which points to select
    """

    filter: Filter


@dataclass
class PointsList:
    """
    A list of points for upsert operations.

    Attributes:
        points: List of PointStruct objects to insert/update
    """

    points: List[PointStruct]


# =============================================================================
# Vector Explorer additions (explorer hooks on the Qdrant store)
# =============================================================================
# The store's explorer hooks use these as well: conditions on ids and nulls,
# ordered scrolls, random sampling, counts, facets and the distance matrix.
# Field names match the real qdrant_client models.


class MatchExcept:
    """Match any value NOT in a list (``FieldCondition(match=MatchExcept(**{'except': [...]}))``)."""

    def __init__(self, **kwargs: Any) -> None:
        """Accept the real model's ``except`` keyword (a Python keyword, hence the alias)."""
        self.except_ = list(kwargs.get('except', kwargs.get('except_', [])) or [])


@dataclass
class HasIdCondition:
    """Match points whose id is in ``has_id``."""

    has_id: List[Any]


@dataclass
class PayloadField:
    """A payload key, as used by ``IsNullCondition`` / ``IsEmptyCondition``."""

    key: str


@dataclass
class IsNullCondition:
    """Match points whose payload value at ``is_null.key`` is null."""

    is_null: PayloadField


@dataclass
class IsEmptyCondition:
    """Match points whose payload value at ``is_empty.key`` is missing, null or an empty list."""

    is_empty: PayloadField


class Direction:
    """Constants for the ordering direction of ``OrderBy``."""

    ASC = 'asc'
    DESC = 'desc'


@dataclass
class OrderBy:
    """Order a scroll by a payload key (real Qdrant needs a range index on it)."""

    key: str
    direction: Optional[str] = None
    start_from: Optional[Any] = None


class Sample:
    """Constants for ``SampleQuery``."""

    RANDOM = 'random'


@dataclass
class SampleQuery:
    """``query_points(query=SampleQuery(sample=Sample.RANDOM))`` draws random points."""

    sample: str


class RecommendStrategy(str, Enum):
    """How a recommendation combines its examples (the real model is a string enum too)."""

    AVERAGE_VECTOR = 'average_vector'
    BEST_SCORE = 'best_score'
    SUM_SCORES = 'sum_scores'


@dataclass
class RecommendInput:
    """Examples of a recommendation: point ids or raw vectors on each side, and the strategy.

    ``strategy`` may be a :class:`RecommendStrategy` or its string value (the real model
    coerces one into the other); None is ``average_vector``.
    """

    positive: Optional[List[Any]] = None
    negative: Optional[List[Any]] = None
    strategy: Optional[Any] = None


@dataclass
class RecommendQuery:
    """``query_points(query=RecommendQuery(recommend=RecommendInput(...)))`` recommends from examples."""

    recommend: RecommendInput


@dataclass
class CountResult:
    """Result of ``count()``."""

    count: int


@dataclass
class FacetValueHit:
    """One facet value and the number of matching points that carry it."""

    value: Any
    count: int


@dataclass
class FacetResponse:
    """Result of ``facet()``: hits sorted by count (descending), then value."""

    hits: List[FacetValueHit]


@dataclass
class SearchMatrixOffsetsResponse:
    """Result of ``search_matrix_offsets()``: a sparse matrix in coordinate form.

    ``offsets_row[i]`` and ``offsets_col[i]`` index ``ids``; ``scores[i]`` is their score.
    """

    offsets_row: List[int]
    offsets_col: List[int]
    scores: List[float]
    ids: List[Any]


@dataclass
class PointIdsList:
    """Selects points by id."""

    points: List[Any]


class Distance:
    """Constants for the distance of a collection's vectors."""

    COSINE = 'Cosine'
    EUCLID = 'Euclid'
    DOT = 'Dot'
    MANHATTAN = 'Manhattan'


@dataclass
class VersionInfo:
    """Result of ``info()``."""

    title: str = 'qdrant - vector search engine'
    version: str = 'mock'
    commit: Optional[str] = None


# =============================================================================
# Aliases
# =============================================================================
# Some code may use alternative names for the same types

Condition = FieldCondition  # Legacy alias used in some examples
