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


# ImageNet normalization stats — BiRefNet's default preprocessing pipeline
# follows the standard timm/torchvision convention.
_IMAGENET_MEAN = (0.485, 0.456, 0.406)
_IMAGENET_STD = (0.229, 0.224, 0.225)

# BiRefNet's expected square input size. The HR checkpoint trains at 2048,
# the standard checkpoint at 1024. We feed the model a square at this size
# (the user-facing max_edge cap controls how aggressively we downscale the
# *source* image before composition).
_BIREFNET_INPUT_SIZE = {
    'ZhengPeng7/BiRefNet': 1024,
    'ZhengPeng7/BiRefNet_HR': 2048,
}
_BIREFNET_INPUT_DEFAULT = 1024


class BackgroundRemover:
    """
    Wraps BiRefNet (MIT) for foreground/background separation.

    Loads the HuggingFace ``image-segmentation``-style model once and exposes
    ``remove(image)`` which returns an RGBA PIL image at the source resolution
    plus a stats dict (mean_alpha, alpha_coverage_pct).

    Engine choices:
      - BiRefNet (MIT) — default. ``ZhengPeng7/BiRefNet`` or ``ZhengPeng7/BiRefNet_HR``.

    Only MIT-licensed engines are wired in here; do not add other matting
    backends without explicit license clearance.

    Attributes:
        model_name (str): HuggingFace model identifier.
        device (str): Torch device string.
        _max_edge (int): Long-edge cap (px) for source/composite resolution.
        _torch_dtype: Resolved torch dtype used for inference.
        _input_size (int): Square model input edge in px.
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
        self.model_name = config.get('model', 'ZhengPeng7/BiRefNet')

        # max_edge: bounds composite/source resolution so memory stays predictable.
        try:
            self._max_edge = int(config.get('maxEdge', 1024))
        except (TypeError, ValueError):
            self._max_edge = 1024
        # Clamp to service-contract bounds so direct config can't push memory/latency
        # into unstable territory with negative or extreme values.
        self._max_edge = min(4096, max(256, self._max_edge))

        # Device: prefer CUDA, then Apple Silicon MPS, then CPU.
        if torch.cuda.is_available():
            self.device = 'cuda:0'
        elif torch.backends.mps.is_available():
            self.device = 'mps'
        else:
            self.device = 'cpu'

        # dtype: bf16 on CUDA, fp16 on MPS, fp32 on CPU. Halves activation memory
        # on GPU. CPU stays in fp32 because PyTorch CPU kernels for fp16/bf16 are
        # slow and unreliable for this workload.
        if self.device.startswith('cuda'):
            self._torch_dtype = torch.bfloat16
        elif self.device.startswith('mps'):
            self._torch_dtype = torch.float16
        else:
            self._torch_dtype = torch.float32

        # Square model input size — picked from the checkpoint name when known.
        self._input_size = _BIREFNET_INPUT_SIZE.get(self.model_name, _BIREFNET_INPUT_DEFAULT)

        self._load_model()

    def _load_model(self):
        """Load the HuggingFace BiRefNet model.

        BiRefNet ships custom modeling code on the Hub, so ``trust_remote_code=True``
        is required. The model exposes a standard ``forward(pixel_values)`` returning
        a list of multi-scale logit tensors; the last entry is the highest-res mask.
        """
        from transformers import AutoModelForImageSegmentation

        self._model = AutoModelForImageSegmentation.from_pretrained(
            self.model_name,
            trust_remote_code=True,
        )
        self._model.to(self.device, dtype=self._torch_dtype)
        self._model.eval()

    def remove(self, image: Any) -> Tuple[Any, Dict[str, float]]:
        """
        Run background removal on a PIL image.

        Args:
            image: PIL Image object (any mode; will be coerced to RGB internally).

        Returns:
            (rgba_image, stats) where:
              - rgba_image is a PIL.Image in mode 'RGBA' at the *original* source
                resolution (capped to ``max_edge`` on the long side for source RGB).
              - stats has keys ``mean_alpha`` (0..1) and ``alpha_coverage_pct``
                (percentage of pixels with alpha > 0.5).
        """
        from ai.common.torch import torch
        import numpy as np
        from PIL import Image

        if image is None:
            raise ValueError('Image must not be None')

        # Coerce to RGB so the source has a stable channel count for compositing.
        rgb_source = image.convert('RGB')

        # Apply the user's max_edge cap to the *source* image first. The composited
        # output then lives at this capped resolution, preserving the user's
        # explicit "I don't want a 12K alpha matte" intent while still being
        # much higher than the model's internal square input.
        source_capped, _orig_size = resize_for_inference(rgb_source, self._max_edge)
        capped_w, capped_h = source_capped.size

        # Resize to the model's expected square input. BiRefNet trains on a fixed
        # square (1024 or 2048) regardless of source aspect; the inferred alpha
        # is then bilinearly upsampled back to the capped source size.
        model_input_pil = source_capped.resize((self._input_size, self._input_size), resample=Image.BILINEAR)

        # ImageNet-normalize. Channel-first float32 in [0, 1] -> normalized.
        arr = np.asarray(model_input_pil, dtype=np.float32) / 255.0
        arr = (arr - np.array(_IMAGENET_MEAN, dtype=np.float32)) / np.array(_IMAGENET_STD, dtype=np.float32)
        # HWC -> CHW, add batch dim.
        tensor = torch.from_numpy(arr.transpose(2, 0, 1)).unsqueeze(0)
        tensor = tensor.to(self.device, dtype=self._torch_dtype)

        with torch.no_grad():
            preds = self._model(tensor)

        # BiRefNet returns either a list/tuple of multi-scale logits or a single
        # tensor. The last entry (highest-res) is the canonical foreground logit.
        if isinstance(preds, (list, tuple)):
            logit = preds[-1]
            # Some forks wrap the logits in another tuple; unwrap once more if so.
            if isinstance(logit, (list, tuple)):
                logit = logit[-1]
        else:
            logit = preds

        # logit shape: [B, 1, H, W]. Sigmoid -> alpha probability.
        alpha = torch.sigmoid(logit).float().squeeze(0).squeeze(0).detach().cpu().numpy()
        # Clamp to [0, 1] then scale to uint8 alpha channel.
        alpha_u8 = (np.clip(alpha, 0.0, 1.0) * 255.0).astype(np.uint8)

        # Upsample alpha from the model's square back to the capped source size.
        # restore_dense_output with mode='bilinear' on a 2D uint8 array uses PIL
        # 'L' mode bilinear resize — exactly what we want for an alpha matte.
        alpha_full = restore_dense_output(alpha_u8, (capped_w, capped_h), mode='bilinear')

        # Composite onto the capped *source* RGB so the source resolution is
        # preserved (capped) and the alpha matches it exactly.
        alpha_pil = Image.fromarray(alpha_full, mode='L')
        r, g, b = source_capped.split()
        # Straight (un-premultiplied) alpha — premultiplied causes dark fringes
        # when consumers re-composite over a non-black background.
        rgba = Image.merge('RGBA', (r, g, b, alpha_pil))

        # Stats are computed on the full-resolution alpha matte so they reflect
        # the actual emitted output rather than the model's downscaled prediction.
        alpha_norm = alpha_full.astype(np.float32) / 255.0
        stats = {
            'mean_alpha': float(alpha_norm.mean()),
            'alpha_coverage_pct': float((alpha_norm > 0.5).mean() * 100.0),
        }

        return rgba, stats
