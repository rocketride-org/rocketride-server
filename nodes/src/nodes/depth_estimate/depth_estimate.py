# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

import os
from depends import depends

requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
depends(requirements)

from typing import Any, Dict, Tuple
from ai.common.config import Config
from ai.common.image.dense_resize import resize_for_inference, restore_dense_output


DEFAULT_MODEL = 'depth-anything/Depth-Anything-V2-Small-hf'


class DepthEstimator:
    """
    Wraps Depth-Anything V2 Small for monocular depth estimation.

    Loads the HuggingFace ``depth-estimation`` pipeline once and exposes
    ``estimate(image)`` which returns a colorized depth map (PIL Image) plus a
    stats dict with min/max/mean depth.

    Attributes:
        model_name (str): HuggingFace model identifier.
        device (str): Torch device string.
        _max_edge (int): Long-edge cap (px) for input downscale before inference.
    """

    def __init__(
        self,
        provider: str,
        connConfig: Dict[str, Any],
        bag: Dict[str, Any],
    ):
        """Load model and configure from provider settings."""
        from ai.common.torch import torch

        config = Config.getNodeConfig(provider, connConfig)
        self.model_name = DEFAULT_MODEL

        # max_edge: bound input resolution so inference memory stays predictable.
        # Falls back to 1024 to match services.json default if config omits it.
        try:
            self._max_edge = int(config.get('maxEdge', 1024))
        except (TypeError, ValueError):
            self._max_edge = 1024

        # Device: prefer CUDA, then Apple Silicon MPS, then CPU.
        if torch.cuda.is_available():
            self.device = 'cuda:0'
        elif torch.backends.mps.is_available():
            self.device = 'mps'
        else:
            self.device = 'cpu'

        # fp32 everywhere — model is ~50MB so the memory savings from fp16/bf16
        # aren't worth the dtype-mismatch failures HF pipelines hit on MPS, and
        # CPU kernels are unreliable in lower precision.
        self._torch_dtype = torch.float32

        self._load_pipeline()

    def _load_pipeline(self):
        """Load the HF depth-estimation pipeline."""
        from transformers import pipeline as hf_pipeline

        # transformers >= 4.36 accepts torch_dtype on pipeline(); we pin 4.53.3.
        self._pipe = hf_pipeline(
            task='depth-estimation',
            model=self.model_name,
            device=self.device,
            torch_dtype=self._torch_dtype,
        )

    def estimate(self, image: Any) -> Tuple[Any, Dict[str, float]]:
        """
        Run depth estimation on a PIL Image.

        Args:
            image: PIL Image object (RGB).

        Returns:
            (colorized_depth_image, stats) where stats has min/max/mean keys.
            Both the colorized image and the stats are at the *original* input
            resolution — internal downscale happens behind max_edge.
        """
        if image is None:
            raise ValueError('Image must not be None')

        # Downscale to bound inference memory; remember original size for upsample.
        resized, original_size = resize_for_inference(image, self._max_edge)

        result = self._pipe(resized)
        predicted = result['predicted_depth']
        # transformers depth pipeline returns a torch tensor; .squeeze().numpy() flattens to HxW.
        depth_np = predicted.squeeze().detach().cpu().float().numpy()

        # Upsample dense depth back to original resolution before computing stats so
        # downstream consumers (and the stats themselves) are independent of max_edge.
        depth_full = restore_dense_output(depth_np, original_size, mode='bilinear')

        stats = {
            'min': float(depth_full.min()),
            'max': float(depth_full.max()),
            'mean': float(depth_full.mean()),
        }

        colorized_small = self._colorize(depth_full)
        # Colorized image is built from depth_full so it is already at original
        # resolution; restore_dense_output here is a no-op but kept for symmetry
        # in case _colorize ever changes shape.
        colorized = restore_dense_output(colorized_small, original_size, mode='bilinear')
        return colorized, stats

    @staticmethod
    def _colorize(depth_np) -> Any:
        """
        Convert raw depth array to a colorized PIL Image.
        Near = red, mid = green, far = blue — matches intuition for most scenes.
        """
        import numpy as np
        from PIL import Image

        d_min, d_max = depth_np.min(), depth_np.max()
        norm = ((depth_np - d_min) / (d_max - d_min + 1e-8) * 255).astype(np.uint8)

        r = norm
        g = (255 - np.abs(norm.astype(np.int16) - 128) * 2).clip(0, 255).astype(np.uint8)
        b = (255 - norm).astype(np.uint8)

        return Image.fromarray(np.stack([r, g, b], axis=-1))
