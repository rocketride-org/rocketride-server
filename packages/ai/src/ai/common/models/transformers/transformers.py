"""
Transformers: Combined loader and user-facing API.

This module provides:
- TransformersLoader: Static methods for load/preprocess/inference/postprocess
  (used by model server and local mode)
- Pipeline, AutoModel, etc.: User-facing classes with automatic local/remote detection
  (used by connectors)
"""

import logging
import os
from typing import Any, Dict, List, Optional, Tuple, Union

from ..base import BaseLoader, get_model_server_address, ModelClient

logger = logging.getLogger('rocketlib.models.transformers')

# Task to output fields mapping for transformers pipelines
TASK_OUTPUT_FIELDS: Dict[str, List[str]] = {
    'text-classification': ['label', 'score'],
    'token-classification': ['entities'],
    'ner': ['entities'],
    'question-answering': ['answer', 'score'],
    'fill-mask': ['token', 'score', 'sequence'],
    'summarization': ['summary_text'],
    'translation': ['translation_text'],
    'text-generation': ['generated_text'],
    'text2text-generation': ['generated_text'],
    'automatic-speech-recognition': ['text'],
    'image-classification': ['label', 'score'],
    'object-detection': ['label', 'score', 'box'],
    'image-segmentation': ['label', 'score', 'mask'],
    'zero-shot-classification': ['labels', 'scores'],
    'feature-extraction': ['features'],
}


def _get_output_fields_for_task(task: str) -> List[str]:
    """Get output fields for a task, with fallback to generic."""
    return TASK_OUTPUT_FIELDS.get(task, ['output'])


class TransformersLoader(BaseLoader):
    """
    Static loader for HuggingFace transformers models.

    Used by:
    - Model server (directly calls static methods)
    - Pipeline/AutoModel wrappers (for local mode)

    Handles loading various transformers models including:
    - Standard models (BERT, GPT, etc.)
    - Whisper (audio transcription)
    - Vision models (ViT, CLIP, etc.)
    - Pipelines (high-level API)

    Model Identity (for sharing):
        model_name + task + model_class + any other loader_options
        All parameters passed during load affect the model identity hash.
    """

    LOADER_TYPE: str = 'transformers'
    _REQUIREMENTS_FILE = os.path.join(os.path.dirname(__file__), 'requirements_transformers.txt')
    _DEFAULTS: dict = {}  # Transformers typically vary by task/model

    @staticmethod
    def load(
        model_name: str,
        device: Optional[str] = None,
        allocate_gpu: Optional[callable] = None,
        exclude_gpus: Optional[List[int]] = None,
        task: Optional[str] = None,
        model_class: Optional[str] = None,
        **kwargs,
    ) -> Tuple[Any, Dict[str, Any], int]:
        """
        Load a transformers model or pipeline.

        Two modes:
        - Local mode (device specified): Load directly to device
        - Server mode (allocate_gpu provided): Measure/estimate, allocate, load

        Args:
            model_name: Model name or path
            device: Device for local mode
            allocate_gpu: Callback for server mode
            exclude_gpus: GPUs to exclude (server mode)
            task: Pipeline task (if using pipeline)
            model_class: Specific model class to use
            **kwargs: Additional arguments

        Returns:
            Tuple of (model_object, metadata_dict, gpu_index)
        """
        TransformersLoader._ensure_dependencies()

        exclude_gpus = exclude_gpus or []

        if task:
            # Pipeline - estimate and load directly to GPU (can't do CPU-first)
            return TransformersLoader._load_pipeline(task, model_name, device, allocate_gpu, exclude_gpus, **kwargs)
        else:
            # Model - CPU-first loading for accurate measurement
            return TransformersLoader._load_model(model_name, device, allocate_gpu, exclude_gpus, model_class, **kwargs)

    @staticmethod
    def _load_model(
        model_name: str,
        device: Optional[str],
        allocate_gpu: Optional[callable],
        exclude_gpus: List[int],
        model_class: Optional[str] = None,
        **kwargs,
    ) -> Tuple[Any, Dict[str, Any], int]:
        """Load a transformers model with CPU-first loading."""
        from transformers import AutoModel
        from ai.common.torch import torch

        # Enable trust_remote_code by default (can be overridden via kwargs)
        kwargs.setdefault('trust_remote_code', True)

        logger.info(f'Loading Transformers model {model_name}...')

        # Determine model class to use
        if model_class:
            import transformers

            ModelClass = getattr(transformers, model_class)
        else:
            ModelClass = AutoModel

        if allocate_gpu:
            # === SERVER MODE: CPU-first loading ===
            model = ModelClass.from_pretrained(model_name, **kwargs)
            model.eval()

            # Load tokenizer/processor
            tokenizer = TransformersLoader._load_tokenizer(model_name)

            # Measure actual memory
            memory_gb = TransformersLoader._get_memory_footprint(model)
            logger.debug(f'Measured memory footprint: {memory_gb:.2f} GB')

            # Allocate GPU
            gpu_index, device = allocate_gpu(memory_gb, exclude_gpus)
            logger.info(f'Allocated GPU {gpu_index} ({device}) for {model_name}')

            # Move to GPU
            model = model.to(device)
            model.eval()
        else:
            # === LOCAL MODE ===
            if device is None:
                device = 'cuda:0' if torch.cuda.is_available() else 'cpu'

            # Load directly to device
            model = ModelClass.from_pretrained(model_name, **kwargs)
            model = model.to(device)
            model.eval()

            tokenizer = TransformersLoader._load_tokenizer(model_name)

            gpu_index = int(device.split(':')[1]) if ':' in device else (0 if device == 'cuda' else -1)
            memory_gb = TransformersLoader._get_memory_footprint(model)

        metadata = {
            'model_name': model_name,
            'model_class': model_class or 'AutoModel',
            'device': device,
            'config': model.config.to_dict() if hasattr(model, 'config') else {},
            'tokenizer': tokenizer,
            'loader': 'transformers',
            'estimated_memory_gb': memory_gb,
        }

        return {'model': model, 'tokenizer': tokenizer}, metadata, gpu_index

    @staticmethod
    def _load_pipeline(
        task: str,
        model_name: Optional[str],
        device: Optional[str],
        allocate_gpu: Optional[callable],
        exclude_gpus: List[int],
        **kwargs,
    ) -> Tuple[Any, Dict[str, Any], int]:
        """Load a transformers pipeline."""
        from transformers import pipeline as hf_pipeline
        from ai.common.torch import torch

        # Enable trust_remote_code by default (can be overridden via kwargs)
        kwargs.setdefault('trust_remote_code', True)

        if allocate_gpu:
            # === SERVER MODE: Estimate, allocate, load ===
            memory_gb = TransformersLoader._estimate_memory(model_name, task=task)
            logger.debug(f'Estimated memory: {memory_gb:.2f} GB')

            gpu_index, device = allocate_gpu(memory_gb, exclude_gpus)
            logger.info(f'Allocated GPU {gpu_index} ({device}) for pipeline {task}/{model_name}')

            # Load pipeline directly to GPU
            pipe = hf_pipeline(task=task, model=model_name, device=gpu_index, **kwargs)
        else:
            # === LOCAL MODE ===
            if device is None:
                device = 0 if torch.cuda.is_available() else -1
            elif isinstance(device, str):
                if device == 'cpu':
                    device = -1
                elif ':' in device:
                    device = int(device.split(':')[1])
                elif device == 'cuda':
                    device = 0

            pipe = hf_pipeline(task=task, model=model_name, device=device, **kwargs)
            gpu_index = device if device >= 0 else -1
            memory_gb = TransformersLoader._estimate_memory(model_name, task=task)

        if hasattr(pipe, 'model'):
            pipe.model.eval()
            memory_gb = TransformersLoader._get_memory_footprint(pipe.model)

        device_str = f'cuda:{gpu_index}' if gpu_index >= 0 else 'cpu'

        metadata = {
            'task': task,
            'model_name': model_name or 'default',
            'device': device_str,
            'loader': 'transformers_pipeline',
            'estimated_memory_gb': memory_gb,
        }

        return pipe, metadata, gpu_index

    @staticmethod
    def _load_tokenizer(model_name: str):
        """Load tokenizer or processor for a model."""
        from transformers import AutoTokenizer, AutoProcessor

        try:
            return AutoTokenizer.from_pretrained(model_name)
        except Exception:
            try:
                return AutoProcessor.from_pretrained(model_name)
            except Exception:
                return None

    @staticmethod
    def preprocess(
        model: Any,
        inputs: List[str],
        metadata: Optional[Dict] = None,
    ) -> Dict[str, Any]:
        """
        Preprocess inputs for transformers model.

        Args:
            model: Model dict or pipeline
            inputs: List of text strings
            metadata: Optional metadata dict

        Returns:
            Dict with preprocessed data
        """
        # Check if this is a pipeline
        is_pipeline = hasattr(model, '__call__') and hasattr(model, 'task')

        if is_pipeline:
            return {
                'inputs': inputs,
                'batch_size': len(inputs),
                'is_pipeline': True,
            }

        # Model dict - get tokenizer
        if isinstance(model, dict):
            tokenizer = model.get('tokenizer')
        elif metadata:
            tokenizer = metadata.get('tokenizer')
        else:
            tokenizer = None

        if tokenizer:
            encoded = tokenizer(inputs, padding=True, truncation=True, return_tensors='pt')
            return {
                'encoded': encoded,
                'batch_size': len(inputs),
                'is_pipeline': False,
            }
        else:
            return {
                'inputs': inputs,
                'batch_size': len(inputs),
                'is_pipeline': True,
            }

    @staticmethod
    def inference(
        model: Any,
        preprocessed: Dict[str, Any],
        metadata: Optional[Dict] = None,
        stream: Optional[Any] = None,
    ) -> Any:
        """
        Run inference.

        Args:
            model: Model dict, pipeline, or ModelInstance
            preprocessed: Output from preprocess()
            metadata: Optional metadata dict
            stream: Optional CUDA stream

        Returns:
            Raw model output
        """
        from ai.common.torch import torch

        is_pipeline = preprocessed.get('is_pipeline', False)

        # Handle ModelInstance (server mode)
        if hasattr(model, 'model_obj'):
            actual_model = model.model_obj
            device = model.metadata.get('device', 'cuda:0')
        else:
            actual_model = model
            device = metadata.get('device', 'cuda:0') if metadata else 'cuda:0'

        if is_pipeline:
            inputs = preprocessed['inputs']
            return actual_model(inputs)

        # Standard model inference
        if isinstance(actual_model, dict) and 'model' in actual_model:
            actual_model = actual_model['model']

        encoded = preprocessed['encoded']

        with torch.no_grad():
            encoded_gpu = {k: v.to(device, non_blocking=True) for k, v in encoded.items()}
            output = actual_model(**encoded_gpu)
            if torch.cuda.is_available():
                torch.cuda.synchronize()

        return output

    @staticmethod
    def postprocess(
        model: Any,
        raw_output: Any,
        batch_size: int,
        output_fields: List[str],
        **kwargs,
    ) -> List[Dict[str, Any]]:
        """
        Postprocess model output.

        Args:
            model: Model (unused but for API consistency)
            raw_output: Output from inference()
            batch_size: Expected batch size
            output_fields: Fields to extract
            **kwargs: Additional parameters (ignored)

        Returns:
            List of dicts with requested fields
        """
        from ..extract import extract_outputs

        results = []

        # Pipeline output is already a list of dicts
        if isinstance(raw_output, list):
            for item in raw_output:
                extracted = extract_outputs(item, output_fields)
                results.append(extracted)
        else:
            # Model output - extract for each batch item
            if batch_size is None:
                batch_size = 1

            for _ in range(batch_size):
                extracted = extract_outputs(raw_output, output_fields)
                results.append(extracted)

        return results

    @staticmethod
    def _estimate_memory(model_name: str, **kwargs) -> float:
        """Estimate GPU memory required."""
        task = kwargs.get('task')

        task_memory = {
            'text-classification': 0.5,
            'token-classification': 0.5,
            'question-answering': 0.5,
            'fill-mask': 0.5,
            'summarization': 2.0,
            'translation': 2.0,
            'text-generation': 2.0,
            'text2text-generation': 2.0,
            'automatic-speech-recognition': 2.0,
            'image-classification': 1.0,
            'object-detection': 1.5,
            'image-segmentation': 2.0,
            'zero-shot-classification': 1.0,
            'feature-extraction': 0.5,
        }

        if task and task in task_memory:
            return task_memory[task]

        model_lower = model_name.lower() if model_name else ''

        if any(x in model_lower for x in ['llama', 'falcon', 'mistral', 'mixtral']):
            if '70b' in model_lower:
                return 140.0
            if '13b' in model_lower:
                return 26.0
            if '7b' in model_lower:
                return 14.0
            return 14.0

        if 'gpt2' in model_lower:
            if 'xl' in model_lower:
                return 6.0
            if 'large' in model_lower:
                return 3.0
            if 'medium' in model_lower:
                return 1.5
            return 0.5

        if 'bert' in model_lower:
            if 'large' in model_lower:
                return 1.5
            return 0.5

        if 't5' in model_lower:
            if 'xxl' in model_lower:
                return 44.0
            if 'xl' in model_lower:
                return 12.0
            if 'large' in model_lower:
                return 3.0
            return 1.0

        if 'whisper' in model_lower:
            if 'large' in model_lower:
                return 6.0
            if 'medium' in model_lower:
                return 3.0
            if 'small' in model_lower:
                return 1.0
            return 0.5

        return 2.0

    @staticmethod
    def _get_memory_footprint(model: Any) -> float:
        """Get actual GPU memory footprint from a loaded model."""
        try:
            total_params = sum(p.numel() for p in model.parameters())
            bytes_per_param = 4
            total_bytes = total_params * bytes_per_param * 1.3  # 30% overhead
            return round(total_bytes / (1024**3), 2)
        except Exception:
            return 2.0


# =============================================================================
# USER-FACING API CLASSES
# =============================================================================


def pipeline(
    task: str,
    model: Optional[str] = None,
    output_fields: Optional[List[str]] = None,
    device: Optional[Union[int, str]] = None,
    **kwargs,
):
    """
    Create a transformers pipeline (proxy or local).

    Args:
        task: Pipeline task (e.g., 'text-classification', 'ner')
        model: Model name or path (optional)
        output_fields: Fields to extract (auto-detected from task if not provided)
        device: Device (int for cuda index, 'server', 'cpu', etc.)
        **kwargs: Additional pipeline arguments

    Returns:
        Pipeline object (proxy or local)
    """
    server_addr = get_model_server_address()
    should_proxy = server_addr and (device is None or device == 'server')

    output_fields = output_fields or _get_output_fields_for_task(task)

    if should_proxy:
        host, port = server_addr
        return PipelineProxy(task, model, port, host, output_fields, **kwargs)
    else:
        return PipelineLocal(task, model, output_fields, device, **kwargs)


class PipelineProxy:
    """Proxy for transformers.pipeline that routes to model server."""

    def __init__(
        self,
        task: str,
        model: Optional[str],
        port: int,
        host: str,
        output_fields: List[str],
        **kwargs,
    ):
        """Initialize PipelineProxy."""
        self.task = task
        self.model = model
        self.output_fields = output_fields
        self.kwargs = kwargs
        self._client = ModelClient(port, host)
        self._metadata: dict = {}

        self._init_proxy()

    def _init_proxy(self) -> None:
        """Initialize proxy and load pipeline on server."""
        # Note: output_fields is NOT passed during load - it's per-request
        loader_options = {'task': self.task}
        if self.kwargs:
            loader_options.update(self.kwargs)

        self._client.load_model(
            model_name=self.model,
            model_type='transformers',
            loader_options=loader_options,
        )
        self._metadata = self._client.metadata

    def __call__(self, inputs: Any, **kwargs) -> Any:
        """Execute pipeline on inputs."""
        result = self._client.send_command(
            'inference',
            {
                'command': 'pipeline_call',
                'inputs': inputs,
                'output_fields': self.output_fields,
                **kwargs,
            },
        )
        return result.get('result')

    @property
    def metadata(self) -> Dict:
        return self._metadata


class PipelineLocal:
    """Local pipeline wrapper using TransformersLoader."""

    def __init__(
        self,
        task: str,
        model: Optional[str],
        output_fields: List[str],
        device: Optional[Union[int, str]],
        **kwargs,
    ):
        """Initialize PipelineLocal."""
        self.task = task
        self.model_name = model
        self.output_fields = output_fields

        # Load using loader
        self._pipeline, self._metadata, _ = TransformersLoader.load(
            model_name=model,
            device=device if device != 'server' else None,
            task=task,
            **kwargs,
        )
        device_str = self._metadata.get('device', 'cpu')
        if device_str and 'cuda' in str(device_str):
            logger.info('GPU processing is enabled for transformers pipeline')
        else:
            logger.info('GPU processing disabled. Recommend using GPU for better performance.')

    def __call__(self, inputs: Any, **kwargs) -> Any:
        """Execute pipeline on inputs."""
        if isinstance(inputs, str):
            inputs = [inputs]

        preprocessed = TransformersLoader.preprocess(self._pipeline, inputs, self._metadata)
        raw_output = TransformersLoader.inference(self._pipeline, preprocessed, self._metadata)
        results = TransformersLoader.postprocess(self._pipeline, raw_output, len(inputs), self.output_fields)

        return results

    @property
    def metadata(self) -> Dict:
        return self._metadata


class AutoModel:
    """Proxy for transformers.AutoModel."""

    @staticmethod
    def from_pretrained(
        model_name: str,
        output_fields: Optional[List[str]] = None,
        device: Optional[str] = None,
        **kwargs,
    ):
        """
        Load a model (proxy or local).

        Args:
            model_name: Model name or path
            output_fields: Fields to extract
            device: Device specification
            **kwargs: Additional arguments

        Returns:
            Model object (proxy or local)
        """
        server_addr = get_model_server_address()
        should_proxy = server_addr and (device is None or device == 'server')

        output_fields = output_fields or ['output']

        if should_proxy:
            host, port = server_addr
            return ModelProxy(model_name, port, host, output_fields, **kwargs)
        else:
            return ModelLocal(model_name, output_fields, device, **kwargs)


class ModelProxy:
    """Proxy for direct transformers model usage."""

    def __init__(
        self,
        model_name: str,
        port: int,
        host: str,
        output_fields: List[str],
        **kwargs,
    ):
        """Initialize ModelProxy."""
        self.model_name = model_name
        self.output_fields = output_fields
        self.kwargs = kwargs
        self._client = ModelClient(port, host)

        self._init_proxy()

    def _init_proxy(self) -> None:
        """Initialize proxy and load model on server."""
        # Note: output_fields is NOT passed during load - it's per-request
        self._client.load_model(
            model_name=self.model_name,
            model_type='transformers',
            loader_options=self.kwargs if self.kwargs else None,
        )

    def generate(self, **kwargs) -> Any:
        """Generate text (for language models)."""
        result = self._client.send_command(
            'inference',
            {
                'command': 'generate',
                'inputs': kwargs,
                'output_fields': self.output_fields,
            },
        )
        return result.get('result')


class ModelLocal:
    """Local model wrapper using TransformersLoader."""

    def __init__(
        self,
        model_name: str,
        output_fields: List[str],
        device: Optional[str],
        **kwargs,
    ):
        """Initialize ModelLocal."""
        self.model_name = model_name
        self.output_fields = output_fields

        self._model, self._metadata, _ = TransformersLoader.load(
            model_name=model_name,
            device=device if device != 'server' else None,
            **kwargs,
        )

    def __call__(self, inputs: Any, **kwargs) -> Any:
        """Run model inference."""
        if isinstance(inputs, str):
            inputs = [inputs]

        preprocessed = TransformersLoader.preprocess(self._model, inputs, self._metadata)
        raw_output = TransformersLoader.inference(self._model, preprocessed, self._metadata)
        results = TransformersLoader.postprocess(self._model, raw_output, len(inputs), self.output_fields)

        return results

    @property
    def metadata(self) -> Dict:
        return self._metadata


class AutoTokenizer:
    """Proxy for transformers.AutoTokenizer (always local)."""

    @staticmethod
    def from_pretrained(model_name: str, **kwargs):
        """Load a tokenizer (always local)."""
        from transformers import AutoTokenizer as RealAutoTokenizer

        return RealAutoTokenizer.from_pretrained(model_name, **kwargs)
