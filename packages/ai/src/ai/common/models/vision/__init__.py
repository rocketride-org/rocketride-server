"""Vision family: CLIP / ViT embedding, monocular depth, object detection (loaders + facades)."""

from .vision import VisionLoader, CLIPModel, ViTModel
from .depth import DepthEstimatorLoader, DepthEstimator
from .detection import DetectorLoader, Detector
from .segmentation import SegmenterLoader, Segmenter
from .caption import CaptionerLoader, Captioner
from .background import BackgroundRemoverLoader, BackgroundRemover
from .pose import PoseEstimatorLoader, PoseEstimator

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
    'CaptionerLoader',
    'Captioner',
    'BackgroundRemoverLoader',
    'BackgroundRemover',
    'PoseEstimatorLoader',
    'PoseEstimator',
]
