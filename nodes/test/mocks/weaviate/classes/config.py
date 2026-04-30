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
Mock Weaviate configuration classes.
"""

from enum import Enum
from dataclasses import dataclass


class DataType(Enum):
    """Weaviate data types."""

    TEXT = 'text'
    INT = 'int'
    BOOL = 'bool'
    NUMBER = 'number'
    DATE = 'date'
    UUID = 'uuid'
    BLOB = 'blob'


class VectorDistances(Enum):
    """Vector distance metrics."""

    COSINE = 'cosine'
    DOT = 'dot'
    L2_SQUARED = 'l2-squared'
    HAMMING = 'hamming'
    MANHATTAN = 'manhattan'


@dataclass
class Property:
    """Collection property definition."""

    name: str
    data_type: DataType


class Configure:
    """Configuration builders."""

    class Vectorizer:
        @staticmethod
        def none():
            """No vectorizer (bring your own vectors)."""
            return {'vectorizer': 'none'}

    class VectorIndex:
        @staticmethod
        def hnsw(distance_metric: VectorDistances = VectorDistances.COSINE):
            """HNSW vector index configuration."""
            return {'type': 'hnsw', 'distance_metric': distance_metric}
