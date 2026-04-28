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
Mock astrapy.info Module
========================

Provides mock implementations of Astra DB collection info/definition classes.
"""

from typing import Optional
from dataclasses import dataclass


@dataclass
class CollectionVectorOptions:
    """
    Vector configuration options for a collection.

    Attributes:
        dimension: Vector dimensionality (e.g., 1536 for OpenAI embeddings)
        metric: Distance metric - 'cosine', 'euclidean', or 'dot_product'
    """

    dimension: int
    metric: str = 'cosine'


@dataclass
class CollectionLexicalOptions:
    """
    Lexical (text search) options for a collection.

    Attributes:
        enabled: Whether lexical search is enabled
        analyzer: Text analyzer to use (e.g., 'standard')
    """

    enabled: bool = False
    analyzer: str = 'standard'


@dataclass
class CollectionDefinition:
    """
    Full definition for creating a collection.

    Combines vector and lexical options for collection configuration.

    Attributes:
        vector: Vector configuration options
        lexical: Lexical search options
    """

    vector: Optional[CollectionVectorOptions] = None
    lexical: Optional[CollectionLexicalOptions] = None


__all__ = [
    'CollectionDefinition',
    'CollectionVectorOptions',
    'CollectionLexicalOptions',
]
