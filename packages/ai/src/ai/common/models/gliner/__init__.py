"""
GLiNER: Zero-shot Named Entity Recognition.

Provides GLiNER model wrapper with automatic local/remote mode detection.
"""

from .gliner import GLiNER, GLiNERLoader

__all__ = ['GLiNER', 'GLiNERLoader']
