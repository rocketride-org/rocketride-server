"""Vision family: CLIP / ViT embedding, monocular depth, object detection (loaders + facades)."""

from .vision import VisionLoader, CLIPModel, ViTModel
from .depth import DepthEstimatorLoader, DepthEstimator
from .detection import DetectorLoader, Detector
from .segmentation import SegmenterLoader, Segmenter

__all__ = [
    'VisionLoader',
    'CLIPModel',
    'ViTModel',
    'DepthEstimatorLoader',
    'DepthEstimator',
    'DetectorLoader',
    'Detector',
    'SegmenterLoader',
    'Segmenter',
]
