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
Mock qdrant_client.conversions.common_types Module
===================================================

This module provides mock implementations of common types used for
configuration and metadata in the qdrant_client library.

These types are typically used when:
- Creating collections (VectorParams for vector configuration)
- Retrieving collection info (CollectionInfo for metadata)

Implementing Common Types:
--------------------------
1. Check what the node code actually uses from this module
2. Implement only the required fields - many real fields can be omitted
3. Use dataclasses with default values for optional fields
4. Use field(default_factory=...) for mutable defaults (lists, dicts)
"""

from typing import Dict, Any
from dataclasses import dataclass, field


@dataclass
class VectorParams:
    """
    Vector configuration for a collection.

    Specifies the dimensions and distance metric for vectors in a collection.
    Must be provided when creating a new collection.

    Attributes:
        size: Vector dimensionality (e.g., 1536 for OpenAI text-embedding-3-small)
        distance: Distance metric - "Cosine", "Euclidean", or "Dot"

    Example:
        VectorParams(size=1536, distance="Cosine")

    Note: The RocketRide store dynamically determines the size from the first
    document's embedding and stores it in the schema document.
    """

    size: int
    distance: str


@dataclass
class CollectionInfo:
    """
    Information about a collection.

    Returned by get_collection() to provide metadata about the collection.

    Attributes:
        vectors_count: Number of vectors (points) in the collection
        payload_schema: Dict mapping field names to their indexed types

    Note: The real CollectionInfo has many more fields (status, config,
    optimizer_status, etc.) but the RocketRide store only uses these.
    """

    vectors_count: int = 0
    payload_schema: Dict[str, Any] = field(default_factory=dict)


# =============================================================================
# Additional Types (Add as Needed)
# =============================================================================
# The real common_types module has many more types. Add them here as tests
# reveal they're needed. For example:
#
# @dataclass
# class Distance:
#     """Distance metric enumeration."""
#     COSINE = "Cosine"
#     EUCLIDEAN = "Euclidean"
#     DOT = "Dot"
