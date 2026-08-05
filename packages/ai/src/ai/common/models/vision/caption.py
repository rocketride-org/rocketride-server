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
Caption: image captioning loader + facade (vision family).

- CaptionerLoader: load/preprocess/inference/postprocess for Florence-2
  (``trust_remote_code``). Returns a plain caption string (JSON-friendly).
- Captioner: user-facing facade. Uses the model server when --modelserver is
  set, else local. ``caption(image)`` returns a string. ``model_name`` is the
  model identity; ``task`` (caption granularity) is per-request.
"""

import io
import logging
import os
import threading
import time
from typing import Any, Dict, List, Optional, Tuple

from ai.web.metrics import metrics
from ai.common.utils.image_utils import image_to_bytes
from ai.common.utils.cuda_utils import pick_torch_device, pick_torch_dtype, model_gpu_gb
from ..base import BaseLoader, get_model_server_address, ModelClient

logger = logging.getLogger('rocketlib.models.caption')

DEFAULT_MODEL = 'microsoft/Florence-2-base'
DEFAULT_TASK = 'caption'

# Caption granularity -> Florence-2 task token. Detection / grounding / OCR
# tasks are intentionally omitted (the dedicated Object Detection and OCR nodes
# use stronger models for those jobs).
TASKS = {
    'caption': '<CAPTION>',
    'detailed_caption': '<DETAILED_CAPTION>',
    'more_detailed_caption': '<MORE_DETAILED_CAPTION>',
}

MAX_NEW_TOKENS = 256
# Local-mode watchdog: Florence can hang on complex scenes; skip the frame past this.
INFERENCE_TIMEOUT = 60

# Long-edge (px) the input is downscaled to before captioning. Florence resizes
# internally to its own input, so this is quality-neutral and just trims the
# model-server payload on large images.
INFER_MAX_EDGE = 1024


def _resolve_token(task: Optional[str]) -> str:
    """Map a caption-granularity key to its Florence-2 task token (falling back to <CAPTION>)."""
    return TASKS.get(task or DEFAULT_TASK, TASKS[DEFAULT_TASK])


def _extract_caption(parsed: Any, token: str) -> str:
    """Pull the plain caption string out of Florence-2's post_process_generation result.

    Args:
        parsed: The dict returned by ``processor.post_process_generation``.
        token: The task token used (the dict is keyed by it).

    Returns:
        The caption as a stripped string.
    """
    result = parsed.get(token, parsed) if isinstance(parsed, dict) else parsed
    if isinstance(result, dict) and len(result) == 1:
        only_val = next(iter(result.values()))
        if isinstance(only_val, str):
            return only_val.strip()
    if isinstance(result, (dict, list)):
        import json

        return json.dumps(result)
    return str(result).strip()


class CaptionerLoader(BaseLoader):
    """Static loader for Florence-2 image captioning (``trust_remote_code``)."""

    LOADER_TYPE: str = 'caption'
    _REQUIREMENTS_FILE = [
        os.path.join(os.path.dirname(__file__), 'requirements_vision.txt'),
        os.path.join(os.path.dirname(__file__), 'requirements_caption.txt'),
    ]
    _DEFAULTS: dict = {}

    @staticmethod
    def load(
        model_name: str = DEFAULT_MODEL,
        device: Optional[str] = None,
        allocate_gpu: Optional[callable] = None,
        exclude_gpus: Optional[List[int]] = None,
        revision: Optional[str] = None,
        **kwargs,
    ) -> Tuple[Any, Dict[str, Any], int]:
        """Load Florence-2 (model + processor); fp16 on CUDA, fp32 elsewhere.

        Args:
            model_name: HF model id for the caption model.
            device: Local torch device; ignored when allocate_gpu is provided.
            allocate_gpu: Server callable (memory_gb, exclude_gpus) -> (gpu_index, device).
            exclude_gpus: GPU indices the allocator must avoid.
            revision: Optional pinned model revision.
            **kwargs: Ignored extra loader options.

        Returns:
            Tuple (bundle {'model','processor','device'}, metadata dict, gpu_index) — -1 on CPU.
        """
        CaptionerLoader._ensure_dependencies()

        from transformers import AutoModelForCausalLM, AutoProcessor

        if allocate_gpu:
            gpu_index, device = allocate_gpu(2.0, exclude_gpus or [])
            logger.info(f'Allocated GPU {gpu_index} ({device}) for caption {model_name}')
        else:
            device = device or pick_torch_device()
            gpu_index = int(device.split(':')[1]) if str(device).startswith('cuda:') else -1

        dtype = pick_torch_dtype(device, cuda='float16', mps='float32', cpu='float32')
        model = (
            AutoModelForCausalLM.from_pretrained(
                model_name, torch_dtype=dtype, trust_remote_code=True, revision=revision
            )
            .to(device)
            .eval()
        )
        processor = AutoProcessor.from_pretrained(model_name, trust_remote_code=True, revision=revision)

        metadata = {'device': str(device), 'model_name': model_name, 'loader': 'caption'}
        return {'model': model, 'processor': processor, 'device': device, 'dtype': dtype}, metadata, gpu_index

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
        task: Optional[str] = None,
    ) -> Any:
        """Generate a caption per image for the per-request task granularity.

        Args:
            model: Loaded bundle (or an object exposing model_obj).
            preprocessed: Output of preprocess (expects 'images').
            metadata: Loader metadata (unused).
            stream: Unused streaming handle.
            task: Per-request caption granularity key; None uses the default.

        Returns:
            List of caption strings (one per image).
        """
        from ai.common.torch import torch

        bundle = model if isinstance(model, dict) else getattr(model, 'model_obj', model)
        mdl, processor, device = bundle['model'], bundle['processor'], bundle['device']
        dtype = bundle.get('dtype')
        token = _resolve_token(task)

        captions: List[str] = []
        for image in preprocessed['images']:
            inputs = processor(text=token, images=image, return_tensors='pt').to(device)
            # Match pixel_values to the model dtype (fp16 on CUDA); input_ids stay long.
            if dtype is not None and 'pixel_values' in inputs:
                inputs['pixel_values'] = inputs['pixel_values'].to(dtype)
            with torch.no_grad():
                generated_ids = mdl.generate(
                    input_ids=inputs['input_ids'],
                    pixel_values=inputs['pixel_values'],
                    max_new_tokens=MAX_NEW_TOKENS,
                    num_beams=1,  # greedy — faster, avoids hangs on complex scenes
                )
            text = processor.batch_decode(generated_ids, skip_special_tokens=False)[0]
            parsed = processor.post_process_generation(text, task=token, image_size=(image.width, image.height))
            captions.append(_extract_caption(parsed, token))
        return captions

    @staticmethod
    def postprocess(
        model: Any, raw_output: Any, batch_size: int, output_fields: List[str], **kwargs
    ) -> List[Dict[str, Any]]:
        """Wrap each caption string under the 'caption' field.

        Args:
            model: Loaded bundle (unused).
            raw_output: List of caption strings.
            batch_size: Number of images (unused; arity kept for the interface).
            output_fields: Requested output fields (unused; always emits caption).
            **kwargs: Ignored extra options.

        Returns:
            List of dicts, each {'caption': str}.
        """
        return [{'caption': str(text)} for text in raw_output]


class Captioner:
    """User-facing image captioner. Model server when --modelserver is set, else local."""

    def __init__(
        self,
        model_name: str = DEFAULT_MODEL,
        device: Optional[str] = None,
        task: str = DEFAULT_TASK,
        revision: Optional[str] = None,
        **kwargs,
    ):
        """Set up the captioner in proxy (model server) or local mode.

        Args:
            model_name: HF model id to load.
            device: None/'server' → model server when --modelserver is set; else a local torch device.
            task: Default caption granularity (per-request; not part of identity).
            revision: Optional pinned model revision (part of model identity).
            **kwargs: Extra identity-only loader options forwarded to load/load_model.
        """
        self.model_name = model_name
        self.task = task if task in TASKS else DEFAULT_TASK
        self._revision = revision

        server_addr = get_model_server_address()
        self._proxy_mode = bool(server_addr) and (device is None or device == 'server')

        if self._proxy_mode:
            self._client = ModelClient(server_addr)
            loader_options = {k: v for k, v in {'revision': revision, **kwargs}.items() if v is not None}
            self._client.load_model(model_name=model_name, model_type='caption', loader_options=loader_options or None)
            self._bundle = None
            self._metadata = self._client.metadata
        else:
            self._client = None
            self._bundle, self._metadata, _ = CaptionerLoader.load(
                model_name, device=device if device != 'server' else None, revision=revision, **kwargs
            )

    def caption(self, image: Any, task: Optional[str] = None) -> str:
        """Return a caption string for one image.

        Args:
            image: PIL Image or encoded image bytes.
            task: Override the default caption granularity for this call.

        Returns:
            The caption as a plain string.
        """
        if image is None:
            raise ValueError('Image must not be None')

        task = self.task if task is None else task
        metrics.counter('gpu_inference_count', 1)

        from PIL import Image
        from ai.common.image.dense_resize import resize_for_inference

        # Downscale for inference (quality-neutral; shrinks the model-server payload).
        if hasattr(image, 'size') and hasattr(image, 'mode'):
            image, _ = resize_for_inference(image, INFER_MAX_EDGE)
        elif isinstance(image, (bytes, bytearray)):
            image, _ = resize_for_inference(Image.open(io.BytesIO(image)).convert('RGB'), INFER_MAX_EDGE)

        if self._proxy_mode:
            # The model server enforces its own per-request timeout/retry.
            result = self._client.send_command(
                'rrext_ms_inference',
                {'data': image_to_bytes(image), 'output_fields': ['caption'], 'task': task},
            )
            items = result.get('result', [])
            return items[0].get('caption', '') if items else ''

        return self._caption_local(image, task)

    def _caption_local(self, image: Any, task: str) -> str:
        """Run local inference under a watchdog thread; raise TimeoutError if it hangs.

        Args:
            image: PIL Image or encoded image bytes.
            task: Caption granularity key for this call.

        Returns:
            The caption string.
        """
        result: List[Optional[str]] = [None]
        error: List[Optional[BaseException]] = [None]

        def _work():
            try:
                result[0] = self._infer_local(image, task)
            except BaseException as exc:  # propagated to the caller after join
                error[0] = exc

        worker = threading.Thread(target=_work, daemon=True)
        worker.start()
        worker.join(timeout=INFERENCE_TIMEOUT)
        if worker.is_alive():
            raise TimeoutError(f'caption inference timed out after {INFERENCE_TIMEOUT}s')
        if error[0] is not None:
            raise error[0]
        return result[0] or ''

    def _infer_local(self, image: Any, task: str) -> str:
        """Run preprocess→inference→postprocess locally and record per-phase timing.

        Args:
            image: PIL Image or encoded image bytes.
            task: Caption granularity key for this call.

        Returns:
            The caption string.
        """
        t0 = time.perf_counter()
        pre = CaptionerLoader.preprocess(self._bundle, [image], self._metadata)
        t_pre = (time.perf_counter() - t0) * 1000
        t0 = time.perf_counter()
        raw = CaptionerLoader.inference(self._bundle, pre, self._metadata, task=task)
        t_gpu = (time.perf_counter() - t0) * 1000
        t0 = time.perf_counter()
        out = CaptionerLoader.postprocess(self._bundle, raw, 1, ['caption'], metadata=self._metadata)
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
        return out[0]['caption']

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
