"""
Model Wrappers: Combined loader and user-facing API for various model types.

This package provides:
- BaseLoader: Base class with shared model ID generation and identity logic
- *Loader classes: Static methods for load/preprocess/inference/postprocess
  (used by model server and local mode)
- User-facing classes: Automatic local/remote mode detection
  (used by connectors)

Subpackages:
- audio: Whisper (transcription), Piper TTS, Kokoro TTS (model server)
- gliner: GLiNER (zero-shot NER)
- ocr: EasyOCR, DocTR, Surya, TrOCR
- transformers: SentenceTransformer, pipeline, AutoModel, AutoTokenizer

The loaders use a unified interface so the model server can work with any
model type without model-specific branching.
"""

# Base loader class
from .base import BaseLoader

# Audio models
from .audio import ElevenLabsTTSLoader, OpenAITTSLoader, KokoroLoader, PiperLoader, Whisper, WhisperLoader

# GLiNER models (zero-shot NER)
from .gliner import GLiNER, GLiNERLoader

# OCR models
from .ocr import EasyOCR, EasyOCRLoader
from .ocr import DocTR, DocTRLoader
from .ocr import Surya, SuryaLoader
from .ocr import TrOCR, TrOCRLoader

# Transformer models
from .transformers import SentenceTransformer, SentenceTransformerLoader
from .transformers import pipeline, AutoModel, AutoTokenizer, TransformersLoader

# Vision (CLIP / ViT) image embedding
from .vision import VisionLoader, CLIPModel, ViTModel

__all__ = [
    # Base
    'BaseLoader',
    # Audio
    'ElevenLabsTTSLoader',
    'OpenAITTSLoader',
    'KokoroLoader',
    'PiperLoader',
    'Whisper',
    'WhisperLoader',
    # GLiNER
    'GLiNER',
    'GLiNERLoader',
    # OCR
    'EasyOCR',
    'EasyOCRLoader',
    'DocTR',
    'DocTRLoader',
    'Surya',
    'SuryaLoader',
    'TrOCR',
    'TrOCRLoader',
    # Transformers
    'SentenceTransformer',
    'SentenceTransformerLoader',
    'pipeline',
    'AutoModel',
    'AutoTokenizer',
    'TransformersLoader',
    # Vision
    'VisionLoader',
    'CLIPModel',
    'ViTModel',
]
