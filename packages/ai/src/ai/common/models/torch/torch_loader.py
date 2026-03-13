"""
TorchLoader: Load/preprocess/inference/postprocess for PyTorch .pt models.

Used by:
- Model server (directly calls static methods)
- torch.load() wrapper (for local mode)
"""

import logging
from typing import Any, Dict, List, Optional, Tuple

from ..base import BaseLoader

logger = logging.getLogger('rocketlib.models.torch')


class TorchLoader(BaseLoader):
    """
    Static loader for PyTorch models (.pt / torch.save format).

    Used by:
    - Model server (directly calls static methods)
    - _TorchWrapper (for local mode)

    Key characteristics:
    - File path is the model identity
    - Accepts generic tensor inputs (Python lists converted to tensors)
    - Returns generic tensor outputs (converted back to Python lists)
    - Stateless after loading (thread-safe)
    """

    LOADER_TYPE: str = 'torch'
    _DEFAULTS: dict = {}

    @staticmethod
    def load(
        model_name: str,
        device: Optional[str] = None,
        allocate_gpu: Optional[callable] = None,
        exclude_gpus: Optional[List[int]] = None,
    ) -> Tuple[Any, Dict[str, Any], int]:
        """
        Load a PyTorch model from a .pt file.

        Two modes:
        - Local mode (device specified): Load directly to device
        - Server mode (allocate_gpu provided): CPU-first, measure, allocate, move

        Args:
            model_name: Path to .pt file
            device: Device for local mode ('cuda:0', 'cpu', etc.)
            allocate_gpu: Callback for server mode (memory_gb, exclude_gpus) -> (gpu_index, device_str)
            exclude_gpus: GPUs to exclude (server mode)

        Returns:
            Tuple of (model_object, metadata_dict, gpu_index)
        """
        from ai.common.torch import torch   # pylint: disable=import-outside-toplevel

        exclude_gpus = exclude_gpus or []

        if allocate_gpu:
            # === SERVER MODE: CPU-first for accurate memory measurement ===
            logger.info('Loading torch model %s to CPU...', model_name)
            model = torch.load(model_name, map_location='cpu', weights_only=False)
            if hasattr(model, 'eval'):
                model.eval()

            memory_gb = TorchLoader._get_memory_footprint(model)
            logger.debug('Measured memory footprint: %.2f GB', memory_gb)

            gpu_index, device = allocate_gpu(memory_gb, exclude_gpus)
            logger.info('Allocated GPU %d (%s) for %s', gpu_index, device, model_name)

            if hasattr(model, 'to'):
                model.to(device)
            if hasattr(model, 'eval'):
                model.eval()
        else:
            # === LOCAL MODE: Load directly to specified device ===
            if device is None:
                device = 'cuda:0' if torch.cuda.is_available() else 'cpu'

            logger.info('Loading torch model %s to %s', model_name, device)
            model = torch.load(model_name, map_location=device, weights_only=False)
            if hasattr(model, 'to'):
                model.to(device)
            if hasattr(model, 'eval'):
                model.eval()

            gpu_index = int(device.split(':')[1]) if ':' in device else (0 if device == 'cuda' else -1)
            memory_gb = TorchLoader._get_memory_footprint(model)

        metadata = {
            'device': device,
            'model_name': model_name,
            'loader': 'torch',
            'estimated_memory_gb': memory_gb,
        }

        return model, metadata, gpu_index

    @staticmethod
    def preprocess(model: Any, inputs: List[Any], metadata: Optional[Dict] = None) -> Dict[str, Any]:
        """
        Preprocess inputs for a PyTorch model.

        Converts Python lists/scalars to tensors. Inputs can be:
        - A list of tensors (one per batch item)
        - A list of lists (converted to float tensors)

        Args:
            model: The PyTorch model (unused but kept for API consistency)
            inputs: List of input items (lists or tensors)
            metadata: Optional metadata dict

        Returns:
            Dict with 'inputs' key containing a stacked tensor
        """
        from ai.common.torch import torch   # pylint: disable=import-outside-toplevel

        device = metadata.get('device', 'cuda:0') if metadata else 'cuda:0'

        processed = []
        for item in inputs:
            if isinstance(item, torch.Tensor):
                processed.append(item.to(device))
            else:
                processed.append(torch.tensor(item, dtype=torch.float32, device=device))

        return {
            'inputs': processed,
            'batch_size': len(inputs),
        }

    @staticmethod
    def inference(
        model: Any,
        preprocessed: Dict[str, Any],
        metadata: Optional[Dict] = None,
        stream: Optional[Any] = None,
    ) -> Any:
        """
        Run inference with a PyTorch model.

        Args:
            model: The PyTorch model or ModelInstanceWrapper
            preprocessed: Output from preprocess()
            metadata: Optional metadata dict
            stream: Optional CUDA stream (unused)

        Returns:
            List of model outputs (tensors or tuples)
        """
        from ai.common.torch import torch   # pylint: disable=import-outside-toplevel

        # Handle ModelInstanceWrapper (server mode)
        if hasattr(model, 'model_obj'):
            actual_model = model.model_obj
            device = model.metadata.get('device', 'cuda:0')
        else:
            actual_model = model
            device = metadata.get('device', 'cuda:0') if metadata else 'cuda:0'

        inputs = preprocessed['inputs']
        results = []

        with torch.no_grad():
            for tensor in inputs:
                output = actual_model(tensor.to(device, non_blocking=True))
                results.append(output)

        return results

    @staticmethod
    def postprocess(
        model: Any,
        raw_output: Any,
        batch_size: int,
        output_fields: List[str],
    ) -> List[Dict[str, Any]]:
        """
        Postprocess PyTorch model output.

        Converts tensors to Python-native lists for JSON serialisation.

        Args:
            model: The model (unused but kept for API consistency)
            raw_output: List of outputs from inference()
            batch_size: Expected batch size
            output_fields: Fields to extract (e.g., ['output'])

        Returns:
            List of dicts with 'output' key containing list values
        """
        from ai.common.torch import torch   # pylint: disable=import-outside-toplevel
        from ..extract import extract_outputs   # pylint: disable=import-outside-toplevel

        results = []
        if batch_size > len(raw_output):
            logger.warning('batch_size (%d) exceeds raw_output length (%d); with None', batch_size, len(raw_output))
        for i in range(batch_size):
            raw = raw_output[i] if i < len(raw_output) else None
            if raw is None:
                item_output = {'output': None}
            elif isinstance(raw, torch.Tensor):
                item_output = {'output': raw.cpu().tolist()}
            elif isinstance(raw, (tuple, list)):
                item_output = {'output': [r.cpu().tolist() if isinstance(r, torch.Tensor) else r for r in raw]}
            else:
                item_output = {'output': raw}

            extracted = extract_outputs(item_output, output_fields)
            results.append(extracted)

        return results

    @staticmethod
    def _get_memory_footprint(model: Any) -> float:
        """Estimate GPU memory footprint from a loaded model."""
        try:
            if hasattr(model, 'parameters'):
                total_params = sum(p.numel() for p in model.parameters())
                bytes_per_param = 4
                total_bytes = total_params * bytes_per_param * 1.2  # 20% overhead
                return total_bytes / (1024**3)
        except Exception as e:  # pylint: disable=broad-except
            logger.debug('Failed to estimate memory footprint: %s', e)
        return 0.1  # default estimate for non-nn.Module objects
