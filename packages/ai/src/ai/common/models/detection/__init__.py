"""Permissive-license detection and segmentation loaders."""

from .detection import (
    Mask2FormerInstanceLoader,
    Mask2FormerSemanticLoader,
    MmGDinoLoader,
    RFDetrLoader,
)

__all__ = [
    'Mask2FormerInstanceLoader',
    'Mask2FormerSemanticLoader',
    'MmGDinoLoader',
    'RFDetrLoader',
]
