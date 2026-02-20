"""
Mock Weaviate configuration classes.
"""

from enum import Enum
from dataclasses import dataclass
from typing import Any, Optional


class DataType(Enum):
    """Weaviate data types."""
    TEXT = "text"
    INT = "int"
    BOOL = "bool"
    NUMBER = "number"
    DATE = "date"
    UUID = "uuid"
    BLOB = "blob"


class VectorDistances(Enum):
    """Vector distance metrics."""
    COSINE = "cosine"
    DOT = "dot"
    L2_SQUARED = "l2-squared"
    HAMMING = "hamming"
    MANHATTAN = "manhattan"


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
            return {"vectorizer": "none"}
    
    class VectorIndex:
        @staticmethod
        def hnsw(distance_metric: VectorDistances = VectorDistances.COSINE):
            """HNSW vector index configuration."""
            return {"type": "hnsw", "distance_metric": distance_metric}

