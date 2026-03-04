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

