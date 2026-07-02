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
Object detection loader + facade (vision family).

- RFDetrLoader / MmGDinoLoader: permissive-license backends exposing
  ``detect(image, prompt, threshold) -> [{label, score, box, centroid}]``.
- DetectorLoader: BaseLoader selecting a backend by ``backend`` at load time;
  returns canonical detection dicts (JSON-friendly).
- Detector: user-facing facade. Model server when --modelserver is set, else
  local. ``backend`` is model identity; ``prompt`` + ``threshold`` are
  per-request (so one model copy is shared regardless of query/filter).
"""

import io
import logging
import os
import time
from typing import Any, Dict, List, NamedTuple, Optional, Tuple

from ai.web.metrics import metrics
from ai.common.utils.image_utils import image_to_bytes
from ai.common.utils.cuda_utils import pick_torch_device, model_gpu_gb
from ..base import BaseLoader, get_model_server_address, ModelClient

logger = logging.getLogger('rocketlib.models.detection')


class BackendSpec(NamedTuple):
    """Model specifications."""

    model: str  # model id
    infer_edge: int  # = model input resolution (long edge, px); downscale to it is lossless (boxes mapped back)
    open_vocab: bool  # open-vocab flag


BACKENDS: Dict[str, BackendSpec] = {
    'rfdetr': BackendSpec(model='PekingU/rtdetr_r50vd', infer_edge=560, open_vocab=False),
    'mmgdino': BackendSpec(model='IDEA-Research/grounding-dino-tiny', infer_edge=1333, open_vocab=True),
}
DEFAULT_BACKEND = 'rfdetr'
DEFAULT_THRESHOLD = 0.3
OPEN_VOCAB_BACKENDS = frozenset(b for b, spec in BACKENDS.items() if spec.open_vocab)


def _to_detection(label: str, score: float, x1: float, y1: float, x2: float, y2: float) -> Dict[str, Any]:
    """Build a single canonical detection dict {label, score, box, centroid}."""
    x1, y1, x2, y2 = float(x1), float(y1), float(x2), float(y2)
    return {
        'label': str(label),
        'score': float(score),
        'box': {'x1': x1, 'y1': y1, 'x2': x2, 'y2': y2},
        'centroid': {'x': (x1 + x2) / 2.0, 'y': (y1 + y2) / 2.0},
    }


def _parse_prompt(prompt: str) -> List[str]:
    """Split a detection prompt on commas/periods into a clean class list."""
    if not prompt:
        return []
    return [c.strip() for c in prompt.replace('.', ',').split(',') if c.strip()]


class RFDetrLoader:
    """RF-DETR closed-set detector (Apache-2.0). Prefers the rfdetr package; falls back to RT-DETR."""

    DEFAULT_MODEL = 'PekingU/rtdetr_r50vd'

    def __init__(
        self,
        model_name: Optional[str] = None,
        threshold: float = DEFAULT_THRESHOLD,
        device: Optional[str] = None,
        revision: Optional[str] = None,
    ):
        """Build the RF-DETR (or RT-DETR fallback) model.

        Args:
            model_name: HF/package model id.
            threshold: Default confidence threshold.
            device: Torch device string, or None to auto-pick.
            revision: Optional pinned model revision (RT-DETR fallback only; the rfdetr
                package pins via its own version, not an HF revision).
        """
        from ai.common.torch import torch

        self.model_name = model_name or self.DEFAULT_MODEL
        self.threshold = float(threshold)
        self.device = device or pick_torch_device()
        self._impl = None
        self._labels: Dict[int, str] = {}
        self._class_names: Dict[int, str] = {}

        try:
            import contextlib
            import sys
            import types

            # supervision (pulled by rfdetr) imports matplotlib.pyplot at module load.
            # matplotlib >= 3.10 ships ft2font as a pybind11 extension whose attribute
            # probe aborts the embedded engine (SIGABRT, "module 'matplotlib.ft2font'
            # has no attribute '__path__'") — a C++ terminate the except below can't
            # catch, so it kills the whole model server. pyplot is only used by
            # supervision plotting helpers we never call, so stub it before importing
            # rfdetr. Mirrors nodes/face_detection.py.
            sys.modules.setdefault('matplotlib.pyplot', types.ModuleType('matplotlib.pyplot'))

            from rfdetr import RFDETRBase  # type: ignore

            # rfdetr saves its checkpoint as "rf-detr-base.pth" in the cwd. If the cwd is on
            # sys.path, site.py parses that binary .pth as a path-config file and crashes the
            # interpreter at startup. Download into the engine cache (off sys.path) instead.
            from depends import model_cache_dir

            with contextlib.chdir(model_cache_dir('rfdetr')):
                self._model = RFDETRBase()
            self._impl = 'rfdetr'
            # {class_id: name} from the model (defaults to COCO_CLASSES) — map ids to names.
            self._class_names = getattr(self._model, 'class_names', None) or {}
        except Exception:
            from transformers import AutoImageProcessor, RTDetrForObjectDetection

            self._processor = AutoImageProcessor.from_pretrained(self.model_name, revision=revision)
            self._model = (
                RTDetrForObjectDetection.from_pretrained(self.model_name, revision=revision).to(self.device).eval()
            )
            self._labels = getattr(self._model.config, 'id2label', {}) or {}
            self._impl = 'rtdetr'
        self._torch = torch

    def detect(
        self, image: Any, prompt: Optional[str] = None, threshold: Optional[float] = None
    ) -> List[Dict[str, Any]]:
        """Run detection. ``prompt`` is ignored (closed-set); ``threshold`` overrides the default.

        Args:
            image: PIL image.
            prompt: Ignored.
            threshold: Per-request confidence threshold; None uses the default.

        Returns:
            Canonical detection dicts.
        """
        if image is None:
            raise ValueError('Image must not be None')

        thr = self.threshold if threshold is None else float(threshold)

        if self._impl == 'rfdetr':
            preds = self._model.predict(image, threshold=thr)
            boxes = getattr(preds, 'xyxy', None)
            scores = getattr(preds, 'confidence', None)
            class_ids = getattr(preds, 'class_id', None)
            labels = getattr(preds, 'data', {}).get('class_name') if hasattr(preds, 'data') else None

            if boxes is None or scores is None:
                return []

            out: List[Dict[str, Any]] = []
            for i in range(len(boxes)):
                x1, y1, x2, y2 = [float(v) for v in boxes[i]]
                score = float(scores[i])
                if score < thr:
                    continue
                if labels is not None:
                    label = str(labels[i])
                elif class_ids is not None:
                    cid = int(class_ids[i])
                    label = str(self._class_names.get(cid, cid))
                else:
                    label = 'object'
                out.append(_to_detection(label, score, x1, y1, x2, y2))
            return out

        torch = self._torch
        inputs = self._processor(images=image, return_tensors='pt').to(self.device)
        with torch.no_grad():
            outputs = self._model(**inputs)

        target_sizes = torch.tensor([(image.height, image.width)], device=self.device)
        results = self._processor.post_process_object_detection(outputs, target_sizes=target_sizes, threshold=thr)[0]

        out = []
        for score, label_id, box in zip(results['scores'], results['labels'], results['boxes']):
            label = self._labels.get(int(label_id), str(int(label_id)))
            x1, y1, x2, y2 = box.tolist()
            out.append(_to_detection(label, float(score), x1, y1, x2, y2))
        return out


class MmGDinoLoader:
    """Grounding-DINO open-vocabulary detector (Apache-2.0 / BSD-3). Requires a prompt."""

    DEFAULT_MODEL = 'IDEA-Research/grounding-dino-tiny'

    def __init__(
        self,
        model_name: Optional[str] = None,
        threshold: float = DEFAULT_THRESHOLD,
        text_threshold: float = 0.25,
        device: Optional[str] = None,
        revision: Optional[str] = None,
    ):
        """Build the Grounding-DINO model.

        Args:
            model_name: HF model id.
            threshold: Default box confidence threshold.
            text_threshold: Text-match threshold.
            device: Torch device string, or None to auto-pick.
            revision: Optional pinned model revision.
        """
        from transformers import AutoModelForZeroShotObjectDetection, AutoProcessor

        self.model_name = model_name or self.DEFAULT_MODEL
        self.threshold = float(threshold)
        self.text_threshold = float(text_threshold)
        self.device = device or pick_torch_device()

        self._processor = AutoProcessor.from_pretrained(self.model_name, revision=revision)
        self._model = (
            AutoModelForZeroShotObjectDetection.from_pretrained(self.model_name, revision=revision)
            .to(self.device)
            .eval()
        )

    def detect(
        self, image: Any, prompt: Optional[str] = None, threshold: Optional[float] = None
    ) -> List[Dict[str, Any]]:
        """Run open-vocab detection over the prompt's classes.

        Args:
            image: PIL image.
            prompt: Comma/period-separated classes; empty returns [].
            threshold: Per-request box threshold; None uses the default.

        Returns:
            Canonical detection dicts.
        """
        from ai.common.torch import torch

        if image is None:
            raise ValueError('Image must not be None')

        thr = self.threshold if threshold is None else float(threshold)
        classes = _parse_prompt(prompt or '')
        if not classes:
            return []

        text = '. '.join(c.lower() for c in classes) + '.'
        inputs = self._processor(images=image, text=text, return_tensors='pt').to(self.device)
        with torch.no_grad():
            outputs = self._model(**inputs)

        target_sizes = torch.tensor([(image.height, image.width)], device=self.device)
        results = self._processor.post_process_grounded_object_detection(
            outputs,
            inputs.input_ids,
            box_threshold=thr,
            text_threshold=self.text_threshold,
            target_sizes=target_sizes,
        )[0]

        out = []
        labels_field = results.get('labels') or results.get('text_labels') or []
        for score, label, box in zip(results['scores'], labels_field, results['boxes']):
            x1, y1, x2, y2 = box.tolist()
            out.append(_to_detection(str(label), float(score), x1, y1, x2, y2))
        return out


def _build_backend(
    backend: str,
    model_name: str,
    device: Optional[str],
    revision: Optional[str] = None,
):
    """Construct the underlying detector for a backend.

    Args:
        backend: 'rfdetr' (closed-set) or 'mmgdino' (open-vocab).
        model_name: HF/package model id.
        device: Torch device string, or None to auto-pick.
        revision: Optional pinned model revision (HF backends only).

    Returns:
        A loader exposing ``detect(image, prompt, threshold)``.
    """
    if backend == 'mmgdino':
        return MmGDinoLoader(model_name=model_name, device=device, revision=revision)
    return RFDetrLoader(model_name=model_name, device=device, revision=revision)


class DetectorLoader(BaseLoader):
    """Static loader for object detection (RF-DETR / Grounding-DINO via ``backend``)."""

    LOADER_TYPE: str = 'detection'
    _REQUIREMENTS_FILE = [
        os.path.join(os.path.dirname(__file__), 'requirements_vision.txt'),
        os.path.join(os.path.dirname(__file__), 'requirements_detection.txt'),
    ]
    _DEFAULTS: dict = {'backend': DEFAULT_BACKEND}

    @staticmethod
    def load(
        model_name: str = BACKENDS[DEFAULT_BACKEND].model,
        backend: str = DEFAULT_BACKEND,
        device: Optional[str] = None,
        allocate_gpu: Optional[callable] = None,
        exclude_gpus: Optional[List[int]] = None,
        revision: Optional[str] = None,
        **kwargs,
    ) -> Tuple[Any, Dict[str, Any], int]:
        """Build the detector for the chosen backend.

        Args:
            model_name: HF/package model id (defaults to the backend's model).
            backend: 'rfdetr' or 'mmgdino' (part of model identity).
            device: Local torch device; ignored when allocate_gpu is provided.
            allocate_gpu: Server callable (memory_gb, exclude_gpus) -> (gpu_index, device).
            exclude_gpus: GPU indices the allocator must avoid.
            revision: Optional pinned model revision (identity only).
            **kwargs: Ignored extra loader options.

        Returns:
            Tuple (bundle {'detector','backend'}, metadata dict, gpu_index) — -1 on CPU.
        """
        DetectorLoader._ensure_dependencies()

        if allocate_gpu:
            gpu_index, device = allocate_gpu(2.0, exclude_gpus or [])
            logger.info(f'Allocated GPU {gpu_index} ({device}) for detection {backend}/{model_name}')
        else:
            device = device or pick_torch_device()
            gpu_index = int(device.split(':')[1]) if str(device).startswith('cuda:') else -1

        detector = _build_backend(backend, model_name, device, revision=revision)
        metadata = {
            'device': str(device),
            'model_name': model_name,
            'backend': backend,
            'loader': 'detection',
        }
        return {'detector': detector, 'backend': backend}, metadata, gpu_index

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
        """Run detection on each image with the per-request prompt/threshold.

        Args:
            model: Loaded bundle (or an object exposing model_obj).
            preprocessed: Output of preprocess (expects 'images').
            metadata: Loader metadata (unused).
            stream: Unused streaming handle.
            prompt: Per-request open-vocab prompt (ignored by closed-set backends).
            threshold: Per-request confidence threshold; None uses the backend default.

        Returns:
            List of per-image detection lists.
        """
        bundle = model if isinstance(model, dict) else getattr(model, 'model_obj', model)
        detector = bundle['detector']
        return [detector.detect(img, prompt=prompt, threshold=threshold) for img in preprocessed['images']]

    @staticmethod
    def postprocess(
        model: Any, raw_output: Any, batch_size: int, output_fields: List[str], **kwargs
    ) -> List[Dict[str, Any]]:
        """Wrap each per-image detection list under the 'detections' field.

        Args:
            model: Loaded bundle (unused).
            raw_output: List of per-image detection lists.
            batch_size: Number of images (unused; arity kept for the interface).
            output_fields: Requested output fields (unused; always emits detections).
            **kwargs: Ignored extra options.

        Returns:
            List of dicts, each {'detections': [...], '$detections': [...]}.
        """
        return [{'detections': dets, '$detections': dets} for dets in raw_output]


class Detector:
    """User-facing object detector. Model server when --modelserver is set, else local."""

    def __init__(
        self,
        backend: str = DEFAULT_BACKEND,
        model_name: Optional[str] = None,
        device: Optional[str] = None,
        threshold: float = DEFAULT_THRESHOLD,
        prompt: Optional[str] = None,
        revision: Optional[str] = None,
        **kwargs,
    ):
        """Set up the detector in proxy (model server) or local mode.

        Args:
            backend: 'rfdetr' or 'mmgdino' (part of model identity).
            model_name: HF/package model id; defaults to the backend's model.
            device: None/'server' → model server when --modelserver is set; else a local device.
            threshold: Default confidence threshold (per-request; not part of identity).
            prompt: Default open-vocab prompt (per-request; not part of identity).
            revision: Optional pinned model revision (part of model identity).
            **kwargs: Extra identity-only loader options.
        """
        self.backend = backend
        self.model_name = model_name or BACKENDS.get(backend, BACKENDS[DEFAULT_BACKEND]).model
        self.threshold = float(threshold)
        self.prompt = prompt
        self._revision = revision
        self._infer_max_edge = BACKENDS.get(backend, BACKENDS[DEFAULT_BACKEND]).infer_edge

        server_addr = get_model_server_address()
        self._proxy_mode = bool(server_addr) and (device is None or device == 'server')

        if self._proxy_mode:
            self._client = ModelClient(server_addr)
            loader_options = {
                k: v for k, v in {'backend': backend, 'revision': revision, **kwargs}.items() if v is not None
            }
            self._client.load_model(
                model_name=self.model_name, model_type='detection', loader_options=loader_options or None
            )
            self._bundle = None
            self._metadata = self._client.metadata
        else:
            self._client = None
            self._bundle, self._metadata, _ = DetectorLoader.load(
                self.model_name,
                backend=backend,
                device=device if device != 'server' else None,
                revision=revision,
                **kwargs,
            )

    def detect(
        self, image: Any, prompt: Optional[str] = None, threshold: Optional[float] = None
    ) -> List[Dict[str, Any]]:
        """Return canonical detection dicts for one image.

        Args:
            image: PIL Image or encoded image bytes.
            prompt: Override the default open-vocab prompt for this call.
            threshold: Override the default confidence threshold for this call.

        Returns:
            List of {label, score, box: {x1,y1,x2,y2}, centroid: {x,y}} dicts.
        """
        if image is None:
            raise ValueError('Image must not be None')

        prompt = self.prompt if prompt is None else prompt
        threshold = self.threshold if threshold is None else threshold
        metrics.counter('gpu_inference_count', 1)

        from PIL import Image
        from ai.common.image.dense_resize import resize_for_inference

        # Run inference on a copy downscaled to the model's input size, then map
        # boxes back so callers get original-resolution coordinates.
        if not hasattr(image, 'size'):
            image = Image.open(io.BytesIO(image)).convert('RGB')
        small, (orig_w, orig_h) = resize_for_inference(image, self._infer_max_edge)

        if self._proxy_mode:
            result = self._client.send_command(
                'rrext_ms_inference',
                {
                    'data': image_to_bytes(small),
                    'output_fields': ['detections'],
                    'prompt': prompt,
                    'threshold': threshold,
                },
            )
            items = result.get('result', [])
            dets = items[0].get('detections', []) if items else []
        else:
            t0 = time.perf_counter()
            pre = DetectorLoader.preprocess(self._bundle, [small], self._metadata)
            t_pre = (time.perf_counter() - t0) * 1000
            t0 = time.perf_counter()
            raw = DetectorLoader.inference(self._bundle, pre, self._metadata, prompt=prompt, threshold=threshold)
            t_gpu = (time.perf_counter() - t0) * 1000
            t0 = time.perf_counter()
            out = DetectorLoader.postprocess(self._bundle, raw, 1, ['detections'], metadata=self._metadata)
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
            dets = out[0]['detections']

        return self._rescale_to_original(dets, small.size, orig_w, orig_h)

    @staticmethod
    def _rescale_to_original(
        dets: List[Dict[str, Any]], small_size: Tuple[int, int], orig_w: int, orig_h: int
    ) -> List[Dict[str, Any]]:
        """Map box/centroid coordinates from the downscaled image back to original size."""
        from ai.common.utils.image_utils import inference_scale, scale_box, scale_point

        factors = inference_scale(small_size, (orig_w, orig_h))
        if not dets or factors is None:
            return dets
        fx, fy = factors
        for d in dets:
            box = d.get('box')
            if box:
                scale_box(box, fx, fy)
            c = d.get('centroid')
            if c:
                scale_point(c, fx, fy)
        return dets

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
