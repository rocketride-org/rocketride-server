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

