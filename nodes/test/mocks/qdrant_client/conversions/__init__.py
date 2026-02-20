"""
Mock qdrant_client.conversions Module
======================================

This module provides mock implementations of the conversion utilities
from the qdrant_client library.

In the real library, this module contains utilities for converting between
different data formats (REST vs gRPC, internal vs external representations).

For the mock, we just need to expose the submodules that the node code imports.

Submodule Structure:
--------------------
The real qdrant_client has:
    qdrant_client/
        conversions/
            __init__.py
            common_types.py  <- CollectionInfo, VectorParams

Node code may import as:
    from qdrant_client.conversions.common_types import VectorParams
    from qdrant_client.conversions import common_types
"""

from . import common_types

# Re-export for convenience
from .common_types import CollectionInfo, VectorParams

__all__ = [
    'common_types',
    'CollectionInfo',
    'VectorParams',
]
