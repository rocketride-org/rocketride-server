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
Mock qdrant_client.http Module
==============================

This module provides a mock of the HTTP client module from qdrant_client.

In the real library, this module contains the HTTP-based client implementation
and various HTTP-specific models. The node code typically doesn't import
directly from this module, but it needs to exist because:

1. Some imports may reference it indirectly
2. The real qdrant_client.http module re-exports models for convenience

What to Mock:
-------------
If tests fail with ImportError mentioning qdrant_client.http, check:

1. What specific class/function is being imported
2. Whether it's already defined in our models.py
3. If so, just re-export it here from models

Adding HTTP-Specific Types:
---------------------------
The real http module has types like:
- ApiClient (the actual HTTP client)
- AsyncQdrantClient (async wrapper)
- Various API response models

Only add these if the node code actually uses them. Most nodes just use
the high-level QdrantClient which abstracts away the HTTP layer.
"""

# Re-export models for code that imports from qdrant_client.http
from .. import models

# If specific http-only types are needed, define them here:
# class SomeHttpOnlyType:
#     pass
