"""
OCR model loaders and user-facing APIs.

Includes:
- EasyOCR (80+ languages, general purpose)
- DocTR (document-focused, configurable architectures)
- Surya (90+ languages, line-level detection)
- TrOCR (CRAFT + TrOCR transformer)

All loaders support:
- Intelligent transparency/alpha handling
- Line grouping (text output with newlines)
- Local and remote (model server) execution
"""

from .easyocr import EasyOCR, EasyOCRLoader
from .doctr import DocTR, DocTRLoader
from .surya import Surya, SuryaLoader
from .trocr import TrOCR, TrOCRLoader
from .utils import preprocess_image_transparency, group_words_into_lines

__all__ = [
    # User-facing
    'EasyOCR',
    'DocTR',
    'Surya',
    'TrOCR',
    # Loaders
    'EasyOCRLoader',
    'DocTRLoader',
    'SuryaLoader',
    'TrOCRLoader',
    # Utilities
    'preprocess_image_transparency',
    'group_words_into_lines',
]
