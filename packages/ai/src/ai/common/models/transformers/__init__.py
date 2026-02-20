"""
Transformer model loaders and user-facing APIs.

Includes:
- SentenceTransformer (sentence embeddings)
- Transformers (HuggingFace pipeline, AutoModel, AutoTokenizer)
"""

from .sentence_transformers import SentenceTransformer, SentenceTransformerLoader
from .transformers import pipeline, AutoModel, AutoTokenizer, TransformersLoader

__all__ = [
    # User-facing
    'SentenceTransformer',
    'pipeline',
    'AutoModel',
    'AutoTokenizer',
    # Loaders
    'SentenceTransformerLoader',
    'TransformersLoader',
]
