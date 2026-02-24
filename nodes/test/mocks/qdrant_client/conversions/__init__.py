# =============================================================================
# MIT License
# Copyright (c) 2026 RocketRide, Inc.
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
