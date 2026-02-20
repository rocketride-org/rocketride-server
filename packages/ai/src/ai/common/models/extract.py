"""
Output Extraction - Client-driven field extraction from model outputs.

Philosophy:
    - NO default fields - server extracts exactly what client requests
    - NO built-in field mappings - loaders define what's available
    - Special fields with '$' prefix trigger transformations
    - Everything else is extracted as-is
    - Field names are preserved exactly (what you request is what you get)

Special Fields (transformation prefix '$'):
    $cpu:           Convert tensor to CPU list
    $embeddings:    Convert embedding tensor to list (handles raw tensor, dict, ModelOutput)
    $logits:        Convert logits to softmax probabilities
    $text:          Build full transcript from segments (ASR/Whisper)
    $segments:      Format ASR segments (handles HuggingFace & faster-whisper)
    $attentions:    Flatten tuple of attention tensors
    $boxes:         Format object detection bounding boxes
    $probs:         Softmax over final dimension
    $hidden_states: Extract last hidden state layer

Regular Fields:
    - Extracted directly from model output
    - Tensors converted to lists for JSON transport
    - Nested structures preserved

Usage:
    from ai.common.models.extract import extract_outputs

    # Client requests specific fields
    result = extract_outputs(
        raw_output=model_output,
        output_fields=['embeddings', '$cpu', 'scores']
    )

    # ASR/Whisper example - response keys match request exactly
    result = extract_outputs(
        raw_output=whisper_output,
        output_fields=['$text', '$segments']
    )
    # Returns: {'$text': '...', '$segments': [...]}
"""

import logging
from typing import Any, Dict, List

logger = logging.getLogger('rocketlib.models.extract')


def tensor_to_list(tensor: Any) -> Any:
    """
    Convert a PyTorch tensor to a Python list.

    Handles the common case of needing to serialize tensors for JSON.

    Args:
        tensor: PyTorch tensor or any value

    Returns:
        Python list if tensor, original value otherwise
    """
    if hasattr(tensor, 'cpu') and hasattr(tensor, 'tolist'):
        return tensor.cpu().tolist()
    return tensor


def serialize_value(value: Any) -> Any:
    """
    Recursively convert tensors and numpy types to Python natives for JSON serialization.

    Handles nested structures (dicts, lists, tuples).

    Args:
        value: Any value that may contain tensors or numpy types

    Returns:
        JSON-serializable version of value
    """
    # PyTorch Tensor
    if hasattr(value, 'cpu') and hasattr(value, 'tolist'):
        return value.cpu().tolist()

    # NumPy types
    try:
        import numpy as np

        if isinstance(value, np.ndarray):
            return value.tolist()
        if isinstance(value, np.integer):
            return int(value)
        if isinstance(value, np.floating):
            return float(value)
    except ImportError:
        pass

    # Dict
    if isinstance(value, dict):
        return {k: serialize_value(v) for k, v in value.items()}

    # List or tuple
    if isinstance(value, (list, tuple)):
        result = [serialize_value(item) for item in value]
        return tuple(result) if isinstance(value, tuple) else result

    # Scalar or other
    return value


def extract_field(item: Any, field: str) -> Any:
    """
    Extract a named field from model output.

    - Fields starting with '$' trigger special transformations
    - All other fields are extracted and returned as-is

    Args:
        item: Model output (tensor, dict, dataclass, etc.)
        field: Field name to extract

    Returns:
        Extracted value (may be None if field not found)
    """
    # ===== SPECIAL TRANSFORMATIONS (opt-in with $ prefix) =====

    if field == '$cpu':
        # Convert tensor to CPU list
        if hasattr(item, 'cpu') and hasattr(item, 'tolist'):
            return item.cpu().tolist()
        return item

    if field == '$logits':
        # Convert logits to probabilities via softmax
        if hasattr(item, 'logits'):
            try:
                from ai.common.torch import torch

                probs = torch.softmax(item.logits, dim=-1)
                return probs.cpu().tolist()
            except Exception as e:
                logger.warning(f'Failed to compute $logits: {e}')
                return None
        return None

    if field == '$probs':
        # Apply softmax to the item itself (assuming it's logits)
        try:
            from ai.common.torch import torch

            probs = torch.softmax(item, dim=-1)
            return probs.cpu().tolist()
        except Exception as e:
            logger.warning(f'Failed to compute $probs: {e}')
            return None

    if field == '$text':
        # Build full transcript from ASR segments
        # Handles both HuggingFace Whisper and faster-whisper formats
        if isinstance(item, dict):
            # Try faster-whisper format first (segments with text)
            segments = item.get('segments', [])
            if segments:
                return ' '.join(seg.get('text', '').strip() for seg in segments)

            # Try HuggingFace format (chunks with text)
            chunks = item.get('chunks', [])
            if chunks:
                return ' '.join(c.get('text', '').strip() for c in chunks)

            # Direct text field
            if 'text' in item:
                return item['text']

        return None

    if field == '$segments':
        # Format ASR segments to standardized structure
        # Handles both HuggingFace Whisper and faster-whisper formats
        if isinstance(item, dict):
            result = []

            # Try faster-whisper format first (has start/end directly)
            segments = item.get('segments', [])
            if segments and 'start' in segments[0]:
                for seg in segments:
                    formatted = {
                        'start': seg.get('start', 0.0),
                        'end': seg.get('end', 0.0),
                        'text': seg.get('text', '').strip(),
                    }
                    # Include word-level timestamps if available
                    if 'words' in seg:
                        formatted['words'] = [
                            {
                                'word': w.get('word', ''),
                                'start': w.get('start', 0.0),
                                'end': w.get('end', 0.0),
                                'score': w.get('score', 1.0),
                                'speaker': w.get('speaker'),
                            }
                            for w in seg['words']
                        ]
                    # Include speaker if available
                    if 'speaker' in seg:
                        formatted['speaker'] = seg['speaker']
                    result.append(formatted)
                return result

            # Try HuggingFace format (uses timestamp array)
            chunks = item.get('chunks', item.get('segments', []))
            for c in chunks:
                ts = c.get('timestamp', [None, None])
                result.append(
                    {
                        'start': ts[0] if isinstance(ts, (list, tuple)) and len(ts) > 0 else None,
                        'end': ts[1] if isinstance(ts, (list, tuple)) and len(ts) > 1 else None,
                        'text': c.get('text', '').strip(),
                    }
                )
            return result

        return None

    if field == '$attentions':
        # Flatten tuple of attention tensors
        if hasattr(item, 'attentions') and item.attentions:
            try:
                return [a.cpu().tolist() for a in item.attentions]
            except Exception as e:
                logger.warning(f'Failed to extract $attentions: {e}')
                return None
        return None

    if field == '$boxes':
        # Format bounding boxes (handles both object detection and OCR)

        def normalize_bbox(bbox):
            """Normalize various bbox formats to [x1, y1, x2, y2]."""
            if isinstance(bbox, (list, tuple)):
                if len(bbox) == 4:
                    # [[x,y], [x,y], [x,y], [x,y]] polygon format (EasyOCR)
                    if isinstance(bbox[0], (list, tuple)) and len(bbox[0]) == 2:
                        x_coords = [p[0] for p in bbox]
                        y_coords = [p[1] for p in bbox]
                        return [min(x_coords), min(y_coords), max(x_coords), max(y_coords)]
                    # Already [x1, y1, x2, y2]
                    return list(bbox)
                elif len(bbox) == 2:
                    # [[x1,y1], [x2,y2]] format
                    return [bbox[0][0], bbox[0][1], bbox[1][0], bbox[1][1]]
            return [0, 0, 0, 0]

        if isinstance(item, dict) and 'boxes' in item:
            boxes = item['boxes']

            # OCR format: list of dicts with 'text', 'bbox', 'confidence'
            if isinstance(boxes, list) and boxes and isinstance(boxes[0], dict):
                # Normalize bbox format and serialize all values
                result = []
                for box in boxes:
                    normalized = dict(box)  # Copy to avoid mutating original
                    if 'bbox' in normalized:
                        normalized['bbox'] = serialize_value(normalize_bbox(normalized['bbox']))
                    # Serialize other fields (confidence, text, etc.)
                    result.append(serialize_value(normalized))
                return result

            # Object detection format: separate boxes, labels, scores tensors
            labels = item.get('labels', [])
            scores = item.get('scores', [])

            result = []
            for i, box in enumerate(tensor_to_list(boxes)):
                result.append(
                    {
                        'box': normalize_bbox(box),
                        'label': tensor_to_list(labels[i]) if i < len(labels) else None,
                        'score': tensor_to_list(scores[i]) if i < len(scores) else None,
                    }
                )
            return result
        return None

    if field == '$hidden_states':
        # Extract hidden states (usually a tuple of tensors)
        if hasattr(item, 'hidden_states') and item.hidden_states:
            try:
                # Return only last layer by default (full would be huge)
                last = item.hidden_states[-1]
                return last.cpu().tolist()
            except Exception as e:
                logger.warning(f'Failed to extract $hidden_states: {e}')
                return None
        return None

    if field == '$embeddings':
        # Convert embedding tensor to list (for JSON transport)
        # Handles: raw tensor, dict with 'embeddings', ModelOutput
        if hasattr(item, 'cpu') and hasattr(item, 'tolist'):
            return item.cpu().tolist()
        if isinstance(item, dict) and 'embeddings' in item:
            emb = item['embeddings']
            if hasattr(emb, 'cpu') and hasattr(emb, 'tolist'):
                return emb.cpu().tolist()
            return emb
        if hasattr(item, 'last_hidden_state'):
            # For ModelOutput - return pooled (mean) embedding
            # Note: this is a simple mean, caller may want CLS token or other pooling
            hs = item.last_hidden_state
            return hs.mean(dim=1).cpu().tolist()
        return None

    # ===== DIRECT EXTRACTION (return as-is) =====

    value = None

    # Attribute on object (ModelOutput, dataclass, etc.)
    if hasattr(item, field):
        value = getattr(item, field)

    # Dict key
    elif isinstance(item, dict) and field in item:
        value = item[field]

    # List of dicts - extract from each
    elif isinstance(item, list) and item and isinstance(item[0], dict):
        return [extract_field(x, field) for x in item]

    return value


def extract_outputs(raw_output: Any, output_fields: List[str]) -> Dict[str, Any]:
    """
    Extract requested fields from model output.

    This is the main entry point for output extraction.

    Args:
        raw_output: Raw model output (tensor, ModelOutput, dict, etc.)
        output_fields: List of field names to extract (use '$' prefix for transforms)

    Returns:
        Dict mapping field names to extracted values.
        Field names are preserved exactly (what you request is what you get).
    """
    result = {}

    for field in output_fields:
        value = extract_field(raw_output, field)

        # Serialize for JSON if not a transformation field
        if value is not None and not field.startswith('$'):
            value = serialize_value(value)

        # Preserve field name exactly
        result[field] = value

    return result


def build_batch_result(raw_outputs: List[Any], output_fields: List[str], batch_size: int) -> List[Dict[str, Any]]:
    """
    Build result list for a batch of outputs.

    Args:
        raw_outputs: List of raw model outputs (one per batch item)
        output_fields: Fields to extract from each output
        batch_size: Expected batch size (for validation)

    Returns:
        List of dicts with extracted fields
    """
    results = []

    for i, output in enumerate(raw_outputs):
        if i >= batch_size:
            break

        item_result = extract_outputs(output, output_fields)
        results.append(item_result)

    # Pad if needed
    while len(results) < batch_size:
        results.append({field: None for field in output_fields})

    return results
