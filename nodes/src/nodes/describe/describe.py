# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

import os
from depends import depends

requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
depends(requirements)

from typing import Any, Dict, Optional
from ai.common.config import Config

# Florence-2 task tokens mapped to readable task names
TASKS = {
    'caption': '<CAPTION>',
    'detailed_caption': '<DETAILED_CAPTION>',
    'more_detailed_caption': '<MORE_DETAILED_CAPTION>',
    'detect': '<OD>',
    'dense_regions': '<DENSE_REGION_CAPTION>',
    'ground': '<CAPTION_TO_PHRASE_GROUNDING>',
    'ocr': '<OCR>',
    'ocr_with_regions': '<OCR_WITH_REGION>',
}


class Describer:
    """
    Wraps Florence-2 for the describe node.

    Loads the model once and exposes describe(image, phrase) which runs
    the configured task token and returns a plain string result. All
    output is text — the task determines the content shape (natural
    language, JSON boxes, raw OCR text).

    Attributes:
        model_name (str): HuggingFace model identifier.
        task (str): Florence-2 task token (e.g. '<CAPTION>').
        task_key (str): Human-readable task name from config.
        model: Florence-2 model instance.
        processor: Florence-2 processor instance.
        device (str): Torch device string.
    """

    def __init__(self, provider: str, connConfig: Dict[str, Any], bag: Dict[str, Any]):
        """Load model and configure from provider settings."""
        from transformers import AutoModelForCausalLM, AutoProcessor
        from ai.common.torch import torch

        config = Config.getNodeConfig(provider, connConfig)

        self.model_name = config.get('model', 'microsoft/Florence-2-base')
        self.task_key = config.get('task', 'caption')
        self.task = TASKS.get(self.task_key, '<CAPTION>')

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

    INFERENCE_TIMEOUT = 60  # seconds — skip frame if Florence-2 hangs

    def describe(self, image: Any, phrase: Optional[str] = None) -> str:
        """
        Run Florence-2 on a PIL Image with the configured task.
        Wrapped in a daemon thread with INFERENCE_TIMEOUT to prevent hangs.
        """
        import threading

        if image is None:
            raise ValueError('Image must not be None')

        result_holder = [None]
        exc_holder = [None]

        def _infer():
            try:
                result_holder[0] = self._run_inference(image, phrase)
            except Exception as e:
                exc_holder[0] = e

        t = threading.Thread(target=_infer, daemon=True)
        t.start()
        t.join(timeout=self.INFERENCE_TIMEOUT)

        if t.is_alive():
            raise TimeoutError(f'Florence-2 inference timed out after {self.INFERENCE_TIMEOUT}s')

        if exc_holder[0]:
            raise exc_holder[0]

        return result_holder[0]

    def _run_inference(self, image: Any, phrase: Optional[str] = None) -> str:
        import json
        from ai.common.torch import torch

        text_input = phrase if (self.task_key == 'ground' and phrase) else self.task

        inputs = self.processor(
            text=text_input,
            images=image,
            return_tensors='pt',
        ).to(self.device)

        with torch.no_grad():
            generated_ids = self.model.generate(
                input_ids=inputs['input_ids'],
                pixel_values=inputs['pixel_values'],
                max_new_tokens=256,  # reduced from 1024 — enough for captions/regions
                num_beams=1,  # greedy decoding — faster, avoids hangs on complex scenes
            )

        generated_text = self.processor.batch_decode(generated_ids, skip_special_tokens=False)[0]

        parsed = self.processor.post_process_generation(
            generated_text,
            task=self.task,
            image_size=(image.width, image.height),
        )

        result = parsed.get(self.task, parsed)

        if isinstance(result, dict) or isinstance(result, list):
            return json.dumps(result)

        return str(result).strip()
