"""
Mock astrapy.data_types Module
==============================

Provides mock implementations of Astra DB data types.
"""

from typing import List
from dataclasses import dataclass


@dataclass
class DataAPIVector:
    """
    Wrapper for vector data in Astra DB.
    
    The real DataAPIVector wraps a list of floats for vector storage.
    In the mock, we just store the vector directly.
    
    Attributes:
        vector: The embedding vector (list of floats)
    """
    vector: List[float]
    
    def __init__(self, vector: List[float]):
        """
        Initialize with a vector.
        
        Args:
            vector: List of floats representing the embedding
        """
        self.vector = vector
    
    def __iter__(self):
        """Allow iteration over the vector elements."""
        return iter(self.vector)
    
    def __len__(self):
        """Return the dimension of the vector."""
        return len(self.vector)


__all__ = ['DataAPIVector']

