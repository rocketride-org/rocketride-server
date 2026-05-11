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


class DepthEstimator:
    """
    Wraps Depth Anything (V2 or DA3) for monocular depth estimation.

    Loads the model once and exposes estimate(image) which returns a
    colorized depth map (PIL Image) and a stats dict with min/max/mean depth.

    Attributes:
        model_name (str): HuggingFace model identifier.
        device (str): Torch device string.
        _is_da3 (bool): True if model uses the depth-anything-3 library.
    """

    def __init__(self, provider: str, connConfig: Dict[str, Any], bag: Dict[str, Any]):
        """Load model and configure from provider settings."""
        from ai.common.torch import torch

        config = Config.getNodeConfig(provider, connConfig)
        self.model_name = config.get('model', 'depth-anything/DA3-SMALL')

        if torch.cuda.is_available():
            self.device = 'cuda:0'
        elif torch.backends.mps.is_available():
            self.device = 'mps'
        else:
            self.device = 'cpu'

        # DA3 uses its own library; V2 uses standard transformers pipeline
        self._is_da3 = 'DA3' in self.model_name or 'da3' in self.model_name.lower()

        if self._is_da3:
            self._load_da3()
        else:
            self._load_v2()

    def _load_da3(self):
        try:
            from depth_anything_3 import DepthAnything3
        except ImportError:
            raise ImportError('depth-anything-3 must be installed manually (numpy conflict with opencv):\n  pip install depth-anything-3 --no-deps\n  pip install timm einops huggingface-hub\nOr switch to the V2 Small profile which installs automatically.')
        self._model = DepthAnything3.from_pretrained(self.model_name).to(self.device).eval()

    def _load_v2(self):
        from transformers import pipeline as hf_pipeline

        self._pipe = hf_pipeline(
            task='depth-estimation',
            model=self.model_name,
            device=self.device,
        )

    def estimate(self, image: Any) -> Tuple[Any, Dict[str, float]]:
        """
        Run depth estimation on a PIL Image.

        Args:
            image: PIL Image object (RGB).

        Returns:
            (colorized_depth_image, stats) where stats has min/max/mean keys.
        """
        import numpy as np

        if image is None:
            raise ValueError('Image must not be None')

        if self._is_da3:
            result = self._model.infer(image)
            depth_np = result.cpu().numpy() if hasattr(result, 'cpu') else np.array(result)
        else:
            result = self._pipe(image)
            predicted = result['predicted_depth']
            depth_np = predicted.squeeze().numpy()

        stats = {
            'min': float(depth_np.min()),
            'max': float(depth_np.max()),
            'mean': float(depth_np.mean()),
        }

        colorized = self._colorize(depth_np)
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
