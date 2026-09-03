# =============================================================================
# MIT License
#
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================

"""
Segmentation loader + facade (vision family).

- Mask2FormerInstanceLoader / Mask2FormerSemanticLoader: permissive-license
  backends exposing ``segment(image, ...)`` returning JSON-friendly masks
  (COCO-RLE / base64 class map).
- Sam3ConceptLoader: SAM 3 text-prompted concept segmenter (Meta's custom SAM
  License, gated hub repo) emitting the same instance-mask contract.
- SegmenterLoader: BaseLoader selecting a backend by ``mode`` at load time.
- Segmenter: user-facing facade. Model server when --modelserver is set, else
  local. ``mode`` is model identity; ``threshold`` + ``prompt`` are
  per-request; the facade resize-bounds the input (``max_edge``) and restores
  masks to the source resolution around inference (so it works identically
  local or proxied).
"""

import io
import logging
import os
import time
from typing import Any, Dict, List, Optional, Tuple, Union

from ai.web.metrics import metrics
from ai.common.utils.image_utils import image_to_bytes
from ai.common.utils.cuda_utils import pick_torch_device, pick_torch_dtype, model_gpu_gb
from ..base import BaseLoader, get_model_server_address, ModelClient

logger = logging.getLogger('rocketlib.models.segmentation')

# Mode -> default HF model id.
MODE_DEFAULTS: Dict[str, str] = {
    'instance': 'facebook/mask2former-swin-tiny-coco-instance',
    'semantic': 'facebook/mask2former-swin-tiny-ade-semantic',
    'sam3': 'facebook/sam3',
}
DEFAULT_MODE = 'instance'
MODES = frozenset(MODE_DEFAULTS)
# Modes that require a non-empty text prompt (open-vocabulary concept segmentation).
PROMPT_MODES = frozenset({'sam3'})
DEFAULT_THRESHOLD = 0.3
DEFAULT_MAX_EDGE = 1024


def _encode_rle(binary_mask) -> Dict[str, Any]:
    """COCO-RLE encode a HxW uint8/bool ndarray. Returns a {size, counts:str} dict."""
    import numpy as np
    from pycocotools import mask as mask_util  # type: ignore

    arr = np.asarray(binary_mask)
    if arr.dtype != np.uint8:
        arr = (arr > 0).astype(np.uint8)
    rle = mask_util.encode(np.asfortranarray(arr))
    counts = rle.get('counts')
    if isinstance(counts, bytes):
        rle['counts'] = counts.decode('utf-8')
    return {'size': [int(rle['size'][0]), int(rle['size'][1])], 'counts': rle['counts']}


def _bbox_from_mask(binary_mask) -> Dict[str, float]:
    """Compute a tight axis-aligned bbox from a binary mask. Returns canonical {x1,y1,x2,y2}."""
    import numpy as np

    arr = np.asarray(binary_mask) > 0
    if not arr.any():
        return {'x1': 0.0, 'y1': 0.0, 'x2': 0.0, 'y2': 0.0}
    ys, xs = np.where(arr)
    return {
        'x1': float(xs.min()),
        'y1': float(ys.min()),
        'x2': float(xs.max() + 1),
        'y2': float(ys.max() + 1),
    }


def _outputs_to_cpu(outputs: Any) -> Any:
    """Return model outputs with every tensor moved to host (CPU) memory.

    transformers post-processing converts the tensors it is handed via
    ``.numpy()`` internally, which raises ``TypeError: can't convert cuda:N
    device type tensor to numpy`` for CUDA tensors — an uncaught c10 error
    that kills the whole model-server process on GPU boxes (same failure mode
    detection.py hardened against). Copying to host first is negligible next
    to model compute and independent of the transformers version.
    """
    moved = {k: v.detach().cpu() if hasattr(v, 'cpu') else v for k, v in outputs.items()}
    return type(outputs)(**moved)


class Mask2FormerInstanceLoader:
    """Mask2Former instance segmenter (MIT, ``facebook/mask2former-swin-tiny-coco-instance``)."""

    DEFAULT_MODEL = 'facebook/mask2former-swin-tiny-coco-instance'

    def __init__(
        self,
        model_name: Optional[str] = None,
        threshold: float = DEFAULT_THRESHOLD,
        device: Optional[str] = None,
        revision: Optional[str] = None,
        **_kwargs,
    ):
        """Build the instance segmenter.

        Args:
            model_name: HF model id.
            threshold: Default minimum instance score.
            device: Torch device string, or None to auto-pick.
            revision: Optional pinned model revision.
        """
        from transformers import Mask2FormerForUniversalSegmentation, Mask2FormerImageProcessor
        from ai.common.torch import torch

        self.model_name = model_name or self.DEFAULT_MODEL
        self.threshold = float(threshold)
        self.device = device or pick_torch_device()

        self._processor = Mask2FormerImageProcessor.from_pretrained(self.model_name, revision=revision)
        self._model = (
            Mask2FormerForUniversalSegmentation.from_pretrained(self.model_name, revision=revision)
            .to(self.device)
            .eval()
        )
        self._id2label = getattr(self._model.config, 'id2label', {}) or {}
        self._torch = torch

    def segment(
        self, image: Any, prompt: Optional[str] = None, threshold: Optional[float] = None
    ) -> List[Dict[str, Any]]:
        """Run instance segmentation. ``prompt`` is ignored (closed-set).

        Args:
            image: PIL image.
            prompt: Ignored.
            threshold: Per-request minimum score; None uses the default.

        Returns:
            List of InstanceMask dicts {label, score, box, mask (COCO-RLE)}.
        """
        import numpy as np

        if image is None:
            raise ValueError('Image must not be None')

        thr = self.threshold if threshold is None else float(threshold)
        torch = self._torch
        inputs = self._processor(images=image, return_tensors='pt').to(self.device)
        with torch.no_grad():
            outputs = self._model(**inputs)

        target_size = (image.height, image.width)
        results = self._processor.post_process_instance_segmentation(
            outputs,
            target_sizes=[target_size],
            threshold=thr,
        )[0]

        segmentation = results.get('segmentation')
        segments_info = results.get('segments_info', []) or []
        if segmentation is None:
            return []

        seg_arr = segmentation.cpu().numpy() if hasattr(segmentation, 'cpu') else np.asarray(segmentation)

        out: List[Dict[str, Any]] = []
        for seg in segments_info:
            seg_id = int(seg.get('id', -1))
            if seg_id < 0:
                continue
            score = float(seg.get('score', 0.0))
            if score < thr:
                continue
            label_id = int(seg.get('label_id', -1))
            label = self._id2label.get(label_id, str(label_id))
            binary = seg_arr == seg_id
            if not binary.any():
                continue
            out.append(
                {
                    'label': label,
                    'score': score,
                    'box': _bbox_from_mask(binary),
                    'mask': _encode_rle(binary),
                }
            )
        return out


class Mask2FormerSemanticLoader:
    """Mask2Former semantic segmenter (MIT, ``facebook/mask2former-swin-tiny-ade-semantic``)."""

    DEFAULT_MODEL = 'facebook/mask2former-swin-tiny-ade-semantic'

    def __init__(
        self,
        model_name: Optional[str] = None,
        threshold: float = 0.0,
        device: Optional[str] = None,
        revision: Optional[str] = None,
        **_kwargs,
    ):
        """Build the semantic segmenter.

        Args:
            model_name: HF model id.
            threshold: Unused (semantic emits a full class map).
            device: Torch device string, or None to auto-pick.
            revision: Optional pinned model revision.
        """
        from transformers import Mask2FormerForUniversalSegmentation, Mask2FormerImageProcessor
        from ai.common.torch import torch

        self.model_name = model_name or self.DEFAULT_MODEL
        self.threshold = float(threshold)
        self.device = device or pick_torch_device()

        self._processor = Mask2FormerImageProcessor.from_pretrained(self.model_name, revision=revision)
        self._model = (
            Mask2FormerForUniversalSegmentation.from_pretrained(self.model_name, revision=revision)
            .to(self.device)
            .eval()
        )
        self._id2label = getattr(self._model.config, 'id2label', {}) or {}
        self._torch = torch

    def segment(self, image: Any, prompt: Optional[str] = None, threshold: Optional[float] = None) -> Dict[str, Any]:
        """Run semantic segmentation.

        Args:
            image: PIL image.
            prompt: Ignored.
            threshold: Ignored (semantic emits a full class map).

        Returns:
            SemanticMask dict {semantic_map (RLE of foreground), classes, size, class_map}.
        """
        import base64
        import zlib

        import numpy as np
        from pycocotools import mask as mask_util  # type: ignore

        if image is None:
            raise ValueError('Image must not be None')

        torch = self._torch
        inputs = self._processor(images=image, return_tensors='pt').to(self.device)
        with torch.no_grad():
            outputs = self._model(**inputs)

        target_size = (image.height, image.width)
        seg_map = self._processor.post_process_semantic_segmentation(outputs, target_sizes=[target_size])[0]

        if hasattr(seg_map, 'cpu'):
            seg_arr = seg_map.cpu().numpy().astype(np.uint8)
        else:
            seg_arr = np.asarray(seg_map).astype(np.uint8)

        h, w = int(seg_arr.shape[0]), int(seg_arr.shape[1])

        foreground = (seg_arr != 0).astype(np.uint8)
        rle = mask_util.encode(np.asfortranarray(foreground))
        if isinstance(rle.get('counts'), bytes):
            rle['counts'] = rle['counts'].decode('utf-8')

        class_map_b64 = base64.b64encode(zlib.compress(seg_arr.tobytes())).decode('utf-8')

        present_ids = sorted({int(v) for v in np.unique(seg_arr).tolist()})
        classes = {int(i): str(self._id2label.get(int(i), str(int(i)))) for i in present_ids}

        return {
            'semantic_map': {'size': [h, w], 'counts': rle['counts']},
            'classes': classes,
            'size': [h, w],
            'class_map': class_map_b64,
            'class_map_encoding': 'base64+zlib+uint8',
        }


class Sam3ConceptLoader:
    """SAM 3 concept segmenter (SAM License, ``facebook/sam3``).

    Promptable Concept Segmentation: a short noun-phrase prompt in ("yellow
    school bus"), instance masks + boxes + scores for every matching object
    out. Requires transformers >= 5.0.0 (Sam3Model/Sam3Processor). The hub
    repo ships under Meta's custom SAM License ("other") and is gated —
    access must be requested/accepted on huggingface.co before download.
    """

    DEFAULT_MODEL = 'facebook/sam3'
    MASK_THRESHOLD = 0.5

    def __init__(
        self,
        model_name: Optional[str] = None,
        threshold: float = DEFAULT_THRESHOLD,
        device: Optional[str] = None,
        revision: Optional[str] = None,
        dtype: Optional[str] = None,
        **_kwargs,
    ):
        """Build the concept segmenter.

        Args:
            model_name: HF model id.
            threshold: Default minimum instance score.
            device: Torch device string, or None to auto-pick.
            revision: Optional pinned model revision.
            dtype: Torch dtype name override (e.g. 'float32'); None auto-picks.
        """
        from transformers import Sam3Model, Sam3Processor
        from ai.common.torch import torch

        self.model_name = model_name or self.DEFAULT_MODEL
        self.threshold = float(threshold)
        self.device = device or pick_torch_device()

        self._processor = Sam3Processor.from_pretrained(self.model_name, revision=revision)
        # bf16 shifts scores slightly, so instances scored right at the
        # threshold can flip vs fp32; segment() upcasts to fp32 before
        # thresholding to contain the drift there. dtype='float32' restores
        # exact fp32 outputs when that matters more than speed.
        if dtype:
            self._dtype = getattr(torch, dtype)
        else:
            self._dtype = pick_torch_dtype(self.device, cuda='bfloat16', mps='float32', cpu='float32')
        self._model = (
            Sam3Model.from_pretrained(self.model_name, revision=revision, dtype=self._dtype).to(self.device).eval()
        )
        self._torch = torch

    def segment(
        self, image: Any, prompt: Optional[str] = None, threshold: Optional[float] = None
    ) -> List[Dict[str, Any]]:
        """Run concept segmentation for a text prompt.

        SAM 3 answers ONE noun phrase per query, but the detect node's prompt
        convention is a ' . '-separated concept list ("grass . tree . stairs").
        The list fans out to one query per concept — batched into a single
        forward over shared image features, since the vision encoder is
        independent of the text query — and each instance keeps the concept it
        matched as its label.

        Args:
            image: PIL image.
            prompt: Concept noun phrase, or ' . '-separated list of them;
                empty returns [].
            threshold: Per-request minimum score; None uses the default.

        Returns:
            List of InstanceMask dicts {label, score, box, mask (COCO-RLE)}.
        """
        if image is None:
            raise ValueError('Image must not be None')

        concepts = [c.strip() for c in (prompt or '').split('.')]
        concepts = [c for c in concepts if c]
        if not concepts:
            return []

        thr = self.threshold if threshold is None else float(threshold)
        torch = self._torch
        n = len(concepts)

        # One processor call tokenizes all concepts as a batch; the image is
        # preprocessed once (pixel_values stays batch-1 regardless of n).
        inputs = self._processor(images=image, text=concepts, return_tensors='pt').to(self.device)
        with torch.no_grad():
            vision = self._model.get_vision_features(pixel_values=inputs['pixel_values'].to(self._dtype))
            if n > 1:
                # Broadcast the cached image features across the concept batch.
                # expand() creates views, not copies — no extra GPU memory.
                vision = type(vision)(
                    fpn_hidden_states=tuple(t.expand(n, *t.shape[1:]) for t in vision.fpn_hidden_states),
                    fpn_position_encoding=tuple(t.expand(n, *t.shape[1:]) for t in vision.fpn_position_encoding),
                )
            outputs = self._model(
                vision_embeds=vision,
                input_ids=inputs['input_ids'],
                attention_mask=inputs.get('attention_mask'),
            )

        # GPU-side equivalent of Sam3Processor.post_process_instance_segmentation
        # (scores = sigmoid(pred_logits) [* sigmoid(presence_logits)]; keep
        # score > threshold; bilinear-upsample kept masks; binarize at
        # MASK_THRESHOLD; scale normalized xyxy boxes by (w, h)). The processor
        # method itself needs host tensors (.numpy() internally), which would
        # force copying the full (n, queries, h, w) mask-logit tensor to CPU;
        # filtering here first means only the kept queries ever leave the GPU.
        # Numerics are upcast to fp32 so the model dtype only affects the
        # forward pass.
        scores_all = outputs.pred_logits.float().sigmoid()
        if outputs.presence_logits is not None:
            scores_all = scores_all * outputs.presence_logits.float().sigmoid()
        target_h, target_w = image.height, image.width
        box_scale = torch.tensor(
            [target_w, target_h, target_w, target_h], dtype=torch.float32, device=scores_all.device
        )

        out: List[Dict[str, Any]] = []
        for b, concept in enumerate(concepts):
            keep = scores_all[b] > thr
            if not bool(keep.any()):
                continue
            masks = outputs.pred_masks[b][keep].float().sigmoid()
            masks = torch.nn.functional.interpolate(
                masks.unsqueeze(0), size=(target_h, target_w), mode='bilinear', align_corners=False
            ).squeeze(0)
            result = {
                'scores': scores_all[b][keep].cpu(),
                'boxes': (outputs.pred_boxes[b][keep].float() * box_scale).cpu(),
                'masks': (masks > self.MASK_THRESHOLD).to(torch.long).cpu(),
            }
            out.extend(self._collect_instances(concept, result, thr))
        return out

    def _collect_instances(self, concept: str, results: Dict[str, Any], thr: float) -> List[Dict[str, Any]]:
        """Extract InstanceMask dicts for one concept from its post-processed batch entry."""
        import numpy as np

        masks = results.get('masks')
        scores = results.get('scores')
        boxes = results.get('boxes')
        if masks is None:
            return []

        out: List[Dict[str, Any]] = []
        for i, mask in enumerate(masks):
            score = float(scores[i]) if scores is not None else 0.0
            if score < thr:
                continue
            arr = mask.detach().cpu().numpy() if hasattr(mask, 'cpu') else np.asarray(mask)
            binary = (arr > 0).astype(np.uint8)
            if not binary.any():
                continue
            box = boxes[i] if boxes is not None else None
            if box is not None:
                coords = box.detach().cpu().tolist() if hasattr(box, 'cpu') else list(box)
                x1, y1, x2, y2 = (float(v) for v in coords)
                box_dict = {'x1': x1, 'y1': y1, 'x2': x2, 'y2': y2}
            else:
                box_dict = _bbox_from_mask(binary)
            out.append(
                {
                    'label': concept,
                    'score': score,
                    'box': box_dict,
                    'mask': _encode_rle(binary),
                }
            )
        return out


def _build_backend(mode: str, model_name: str, device: Optional[str], revision: Optional[str] = None):
    """Construct the underlying segmenter for a mode.

    Args:
        mode: 'instance', 'semantic' or 'sam3'.
        model_name: HF model id.
        device: Torch device string, or None to auto-pick.
        revision: Optional pinned model revision.

    Returns:
        A backend exposing ``segment(image, prompt, threshold)``.
    """
    if mode == 'semantic':
        return Mask2FormerSemanticLoader(model_name=model_name, device=device, revision=revision)
    if mode == 'sam3':
        return Sam3ConceptLoader(model_name=model_name, device=device, revision=revision)
    return Mask2FormerInstanceLoader(model_name=model_name, device=device, revision=revision)


class SegmenterLoader(BaseLoader):
    """Static loader for segmentation (Mask2Former instance / semantic, SAM 3 concept via ``mode``)."""

    LOADER_TYPE: str = 'segmentation'
    _REQUIREMENTS_FILE = [
        os.path.join(os.path.dirname(__file__), 'requirements_vision.txt'),
        os.path.join(os.path.dirname(__file__), 'requirements_segmentation.txt'),
    ]
    _DEFAULTS: dict = {'mode': DEFAULT_MODE}

    @staticmethod
    def load(
        model_name: str = MODE_DEFAULTS[DEFAULT_MODE],
        mode: str = DEFAULT_MODE,
        device: Optional[str] = None,
        allocate_gpu: Optional[callable] = None,
        exclude_gpus: Optional[List[int]] = None,
        revision: Optional[str] = None,
        **kwargs,
    ) -> Tuple[Any, Dict[str, Any], int]:
        """Build the segmenter for the chosen mode.

        Args:
            model_name: HF model id (defaults to the mode's model).
            mode: 'instance', 'semantic' or 'sam3' (part of model identity).
            device: Local torch device; ignored when allocate_gpu is provided.
            allocate_gpu: Server callable (memory_gb, exclude_gpus) -> (gpu_index, device).
            exclude_gpus: GPU indices the allocator must avoid.
            revision: Optional pinned model revision (identity only).
            **kwargs: Ignored extra loader options.

        Returns:
            Tuple (bundle {'segmenter','mode'}, metadata dict, gpu_index) — -1 on CPU.
        """
        SegmenterLoader._ensure_dependencies()

        # SAM 3 (~850M params, fp32) needs more headroom than the Mask2Former tinys.
        gpu_gb = 4.5 if mode == 'sam3' else 3.0
        if allocate_gpu:
            gpu_index, device = allocate_gpu(gpu_gb, exclude_gpus or [])
            logger.info(f'Allocated GPU {gpu_index} ({device}) for segmentation {mode}/{model_name}')
        else:
            device = device or pick_torch_device()
            gpu_index = int(device.split(':')[1]) if str(device).startswith('cuda:') else -1

        segmenter = _build_backend(mode, model_name, device, revision=revision)
        metadata = {'device': str(device), 'model_name': model_name, 'mode': mode, 'loader': 'segmentation'}
        return {'segmenter': segmenter, 'mode': mode}, metadata, gpu_index

    @staticmethod
    def preprocess(model: Any, inputs: List[Any], metadata: Optional[Dict] = None) -> Dict[str, Any]:
        """Decode image bytes (or accept PIL) to RGB PIL images.

        Args:
            model: Loaded bundle (unused; kept for the loader interface).
            inputs: List of image bytes and/or PIL images.
            metadata: Loader metadata (unused).

        Returns:
            Dict with 'images' (list of RGB PIL images) and 'batch_size'.
        """
        from PIL import Image

        images = []
        for inp in inputs:
            if isinstance(inp, (bytes, bytearray)):
                images.append(Image.open(io.BytesIO(inp)).convert('RGB'))
            elif hasattr(inp, 'convert'):
                images.append(inp.convert('RGB') if inp.mode != 'RGB' else inp)
            else:
                raise TypeError(f'Expected bytes or PIL Image, got {type(inp)}')
        return {'images': images, 'batch_size': len(images)}

    @staticmethod
    def inference(
        model: Any,
        preprocessed: Dict[str, Any],
        metadata: Optional[Dict] = None,
        stream: Optional[Any] = None,
        prompt: Optional[str] = None,
        threshold: Optional[float] = None,
    ) -> Any:
        """Segment each image (instance list or semantic dict per the loaded mode).

        Args:
            model: Loaded bundle (or an object exposing model_obj).
            preprocessed: Output of preprocess (expects 'images').
            metadata: Loader metadata (unused).
            stream: Unused streaming handle.
            prompt: Per-request concept prompt (ignored by closed-set backends).
            threshold: Per-request instance threshold; None uses the backend default.

        Returns:
            List of per-image results (instance list or semantic dict).
        """
        bundle = model if isinstance(model, dict) else getattr(model, 'model_obj', model)
        segmenter = bundle['segmenter']
        return [segmenter.segment(img, prompt=prompt, threshold=threshold) for img in preprocessed['images']]

    @staticmethod
    def postprocess(
        model: Any, raw_output: Any, batch_size: int, output_fields: List[str], **kwargs
    ) -> List[Dict[str, Any]]:
        """Wrap each per-image segmentation result under the 'masks' field.

        Args:
            model: Loaded bundle (unused).
            raw_output: List of per-image instance lists / semantic dicts.
            batch_size: Number of images (unused; arity kept for the interface).
            output_fields: Requested output fields (unused; always emits masks).
            **kwargs: Ignored extra options.

        Returns:
            List of dicts, each {'masks': <list|dict>, '$masks': <list|dict>}.
        """
        return [{'masks': r, '$masks': r} for r in raw_output]


class Segmenter:
    """User-facing segmenter. Model server when --modelserver is set, else local.

    Resize-bounds the input (``max_edge``) before inference and restores masks to
    the source resolution after — so emitted RLEs match the original frame size
    whether running locally or proxied.
    """

    def __init__(
        self,
        mode: str = DEFAULT_MODE,
        model_name: Optional[str] = None,
        device: Optional[str] = None,
        threshold: float = DEFAULT_THRESHOLD,
        max_edge: int = DEFAULT_MAX_EDGE,
        prompt: Optional[str] = None,
        revision: Optional[str] = None,
        **kwargs,
    ):
        """Set up the segmenter in proxy (model server) or local mode.

        Args:
            mode: 'instance', 'semantic' or 'sam3' (part of model identity).
            model_name: HF model id; defaults to the mode's model.
            device: None/'server' → model server when --modelserver is set; else a local device.
            threshold: Default instance threshold (per-request; not part of identity).
            max_edge: Long-edge bound for the inference resize (client-side; not part of identity).
            prompt: Default concept prompt for prompted modes (per-request; not part of identity).
            revision: Optional pinned model revision (part of model identity).
            **kwargs: Extra identity-only loader options.
        """
        self.mode = mode
        self.model_name = model_name or MODE_DEFAULTS.get(mode, MODE_DEFAULTS[DEFAULT_MODE])
        self.threshold = float(threshold)
        self.max_edge = int(max_edge)
        self.prompt = prompt
        self._revision = revision

        server_addr = get_model_server_address()
        self._proxy_mode = bool(server_addr) and (device is None or device == 'server')

        if self._proxy_mode:
            self._client = ModelClient(server_addr)
            loader_options = {k: v for k, v in {'mode': mode, 'revision': revision, **kwargs}.items() if v is not None}
            self._client.load_model(
                model_name=self.model_name, model_type='segmentation', loader_options=loader_options or None
            )
            self._bundle = None
            self._metadata = self._client.metadata
        else:
            self._client = None
            self._bundle, self._metadata, _ = SegmenterLoader.load(
                self.model_name, mode=mode, device=device if device != 'server' else None, revision=revision, **kwargs
            )

    def segment(
        self, image: Any, prompt: Optional[str] = None, threshold: Optional[float] = None
    ) -> Union[List[Dict[str, Any]], Dict[str, Any]]:
        """Segment one image and restore masks to its original resolution.

        Args:
            image: PIL Image or encoded image bytes.
            prompt: Override the default concept prompt for this call (prompted modes only).
            threshold: Override the default instance threshold for this call.

        Returns:
            instance/sam3 mode: list of InstanceMask dicts; semantic mode: a SemanticMask dict.
        """
        from ai.common.image import ImageProcessor
        from ai.common.image.dense_resize import resize_for_inference

        if image is None:
            raise ValueError('Image must not be None')

        if not hasattr(image, 'size'):
            image = ImageProcessor.load_image_from_bytes(bytes(image))

        prompt = self.prompt if prompt is None else prompt
        threshold = self.threshold if threshold is None else threshold
        resized, original_size = resize_for_inference(image, self.max_edge)
        inf_w, inf_h = resized.size

        raw = self._infer(resized, prompt, threshold)

        if self.mode == 'semantic':
            return self._restore_semantic(raw, original_size, (inf_w, inf_h))
        orig_w, orig_h = original_size
        sx = orig_w / float(inf_w) if inf_w else 1.0
        sy = orig_h / float(inf_h) if inf_h else 1.0
        return self._restore_instances(raw, original_size, sx, sy)

    def _infer(
        self, resized_image: Any, prompt: Optional[str], threshold: Optional[float]
    ) -> Union[List[Dict[str, Any]], Dict[str, Any]]:
        """Run inference on an already-resized image (proxy or local), returning inference-res masks."""
        metrics.counter('gpu_inference_count', 1)
        if self._proxy_mode:
            result = self._client.send_command(
                'rrext_ms_inference',
                {
                    'data': image_to_bytes(resized_image),
                    'output_fields': ['masks'],
                    'prompt': prompt,
                    'threshold': threshold,
                },
            )
            items = result.get('result', [])
            return items[0].get('masks') if items else ([] if self.mode != 'semantic' else {})

        t0 = time.perf_counter()
        pre = SegmenterLoader.preprocess(self._bundle, [resized_image], self._metadata)
        t_pre = (time.perf_counter() - t0) * 1000
        t0 = time.perf_counter()
        raw = SegmenterLoader.inference(self._bundle, pre, self._metadata, prompt=prompt, threshold=threshold)
        t_gpu = (time.perf_counter() - t0) * 1000
        t0 = time.perf_counter()
        out = SegmenterLoader.postprocess(self._bundle, raw, 1, ['masks'], metadata=self._metadata)
        t_post = (time.perf_counter() - t0) * 1000
        inference_sec = (t_pre + t_gpu + t_post) / 1000.0
        metrics.add_time(
            {
                'gpu_preprocess': t_pre,
                'gpu_compute': t_gpu,
                'gpu_postprocess': t_post,
                'gpu_queue_wait': 0,
                'gpu_memory': model_gpu_gb(self._bundle) * inference_sec,
            }
        )
        return out[0]['masks']

    @staticmethod
    def _restore_instances(raw, original_size, sx, sy):
        """Upsample RLE masks and rescale boxes back to the original frame size."""
        from rocketlib import warning
        from ai.common.image.dense_resize import restore_rle_mask

        if not raw:
            return []
        out = []
        orig_w, orig_h = int(original_size[0]), int(original_size[1])
        for inst in raw:
            mask = inst.get('mask')
            if isinstance(mask, dict) and 'counts' in mask and 'size' in mask:
                # RLE size is [h, w]; skip the decode/resize/encode round trip
                # when the mask is already at the target resolution (i.e. the
                # inference downscale was a no-op).
                if [int(mask['size'][0]), int(mask['size'][1])] == [orig_h, orig_w]:
                    rescaled = mask
                else:
                    try:
                        rescaled = restore_rle_mask(mask, original_size)
                    except ImportError as exc:
                        warning(f'detect_segment: {exc}; emitting unscaled mask.')
                        rescaled = mask
            else:
                rescaled = mask
            box = inst.get('box') or {'x1': 0.0, 'y1': 0.0, 'x2': 0.0, 'y2': 0.0}
            out.append(
                {
                    'label': inst.get('label', 'object'),
                    'score': float(inst.get('score', 0.0)),
                    'box': {
                        'x1': float(box['x1']) * sx,
                        'y1': float(box['y1']) * sy,
                        'x2': float(box['x2']) * sx,
                        'y2': float(box['y2']) * sy,
                    },
                    'mask': rescaled,
                }
            )
        return out

    @staticmethod
    def _restore_semantic(result, original_size, inference_size):
        """Upsample the semantic class map back to the source resolution and repack."""
        import base64
        import zlib

        import numpy as np
        from pycocotools import mask as mask_util  # type: ignore
        from ai.common.image.dense_resize import restore_dense_output, restore_rle_mask

        orig_w, orig_h = original_size
        class_map_b64 = result.get('class_map') if isinstance(result, dict) else None
        if class_map_b64:
            inf_w, inf_h = inference_size
            decoded = np.frombuffer(zlib.decompress(base64.b64decode(class_map_b64)), dtype=np.uint8)
            inf_arr = decoded.reshape(inf_h, inf_w)
            full_arr = restore_dense_output(inf_arr, (orig_w, orig_h), mode='nearest')

            foreground = (full_arr != 0).astype(np.uint8)
            rle = mask_util.encode(np.asfortranarray(foreground))
            if isinstance(rle.get('counts'), bytes):
                rle['counts'] = rle['counts'].decode('utf-8')

            present_ids = sorted({int(v) for v in np.unique(full_arr).tolist()})
            classes = {int(i): result.get('classes', {}).get(int(i), str(int(i))) for i in present_ids}

            return {
                'semantic_map': {'size': [int(orig_h), int(orig_w)], 'counts': rle['counts']},
                'classes': classes,
                'size': [int(orig_h), int(orig_w)],
                'class_map': base64.b64encode(zlib.compress(full_arr.tobytes())).decode('utf-8'),
                'class_map_encoding': 'base64+zlib+uint8',
            }

        try:
            rescaled = restore_rle_mask(result['semantic_map'], (orig_w, orig_h))
        except (ImportError, KeyError, TypeError):
            rescaled = result.get('semantic_map') if isinstance(result, dict) else None
        result = dict(result) if isinstance(result, dict) else {}
        if rescaled is not None:
            result['semantic_map'] = rescaled
        result['size'] = [int(orig_h), int(orig_w)]
        return result

    def disconnect(self) -> None:
        """Release the model-server connection (proxy mode only); no-op locally.

        Returns:
            None.
        """
        if self._client is not None:
            try:
                self._client.disconnect()
            except Exception:
                pass
