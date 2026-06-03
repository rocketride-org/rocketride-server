# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

import os
from depends import depends

requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
depends(requirements)

from typing import Any, Dict
from ai.common.config import Config


# Florence-2 task tokens mapped to human-readable task names.
# Only the three caption granularities are exposed — detection / grounding /
# OCR tasks were removed in favor of the dedicated Object Detection and OCR
# nodes (those models are stronger for their respective jobs).
TASKS = {
    'caption': '<CAPTION>',
    'detailed_caption': '<DETAILED_CAPTION>',
    'more_detailed_caption': '<MORE_DETAILED_CAPTION>',
}


class _FlorenceEngine:
    """Florence-2 caption engine (default, MIT licensed)."""

    def __init__(self, model_name: str, task_key: str):
        from transformers import AutoModelForCausalLM, AutoProcessor
        from ai.common.torch import torch

        self.model_name = model_name
        self.task_key = task_key
        self.task = TASKS.get(task_key, '<CAPTION>')

        if torch.cuda.is_available():
            self.device = 'cuda:0'
            dtype = torch.float16
        elif torch.backends.mps.is_available():
            self.device = 'mps'
            dtype = torch.float32
        else:
            self.device = 'cpu'
            dtype = torch.float32

        self.model = (
            AutoModelForCausalLM.from_pretrained(
                self.model_name,
                torch_dtype=dtype,
                trust_remote_code=True,
            )
            .to(self.device)
            .eval()
        )

        self.processor = AutoProcessor.from_pretrained(
            self.model_name,
            trust_remote_code=True,
        )

    def _run_inference(self, image: Any) -> str:
        """Return the Florence-2 caption as a plain string."""
        from ai.common.torch import torch

        inputs = self.processor(
            text=self.task,
            images=image,
            return_tensors='pt',
        ).to(self.device)

        with torch.no_grad():
            generated_ids = self.model.generate(
                input_ids=inputs['input_ids'],
                pixel_values=inputs['pixel_values'],
                max_new_tokens=256,
                num_beams=1,  # greedy — faster, avoids hangs on complex scenes
            )

        generated_text = self.processor.batch_decode(generated_ids, skip_special_tokens=False)[0]

        parsed = self.processor.post_process_generation(
            generated_text,
            task=self.task,
            image_size=(image.width, image.height),
        )

        # Florence returns a dict keyed by the task token; the value for caption
        # tasks is always a plain string.
        result = parsed.get(self.task, parsed)
        if isinstance(result, (dict, list)):
            # Defensive: unwrap if Florence ever returns a single-key dict.
            if isinstance(result, dict) and len(result) == 1:
                only_val = next(iter(result.values()))
                if isinstance(only_val, str):
                    return only_val
            import json

            return json.dumps(result)
        return str(result).strip()


class Captioner:
    """
    Loads Florence-2 Base once and exposes ``caption(image)`` which runs
    inference in a daemon thread with a 60s timeout and returns a plain
    string caption.

    Attributes:
        model_name (str): HuggingFace model identifier.
        task_key (str): Caption granularity from config.
        engine: ``_FlorenceEngine`` instance.
    """

    INFERENCE_TIMEOUT = 60  # seconds — skip frame if inference hangs

    def __init__(self, provider: str, connConfig: Dict[str, Any], bag: Dict[str, Any]):
        """Load engine and configure from provider settings."""
        config = Config.getNodeConfig(provider, connConfig)

        self.task_key = config.get('task', 'caption')
        if self.task_key not in TASKS:
            self.task_key = 'caption'

        self.model_name = config.get('model', 'microsoft/Florence-2-base')
        self.engine = _FlorenceEngine(self.model_name, self.task_key)
        self.device = self.engine.device

    def caption(self, image: Any) -> str:
        """
        Run inference on a PIL Image. Returns a plain string caption.
        Wrapped in a daemon thread with ``INFERENCE_TIMEOUT`` to prevent hangs.
        """
        import threading

        if image is None:
            raise ValueError('Image must not be None')

        result_holder: list = [None]
        exc_holder: list = [None]

        def _infer():
            try:
                result_holder[0] = self.engine._run_inference(image)
            except Exception as e:
                exc_holder[0] = e

        t = threading.Thread(target=_infer, daemon=True)
        t.start()
        t.join(timeout=self.INFERENCE_TIMEOUT)

        if t.is_alive():
            raise TimeoutError(f'caption inference timed out after {self.INFERENCE_TIMEOUT}s')

        if exc_holder[0]:
            raise exc_holder[0]

        raw = result_holder[0]
        return str(raw).strip() if raw is not None else ''
