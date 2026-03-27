# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Hugging Face Hub helpers for Piper ONNX voices (rhasspy/piper-voices)."""

from __future__ import annotations

import json
from typing import Any, Dict

PIPER_VOICES_REPO_ID = 'rhasspy/piper-voices'


def _hf_hub_download(filename: str) -> str:
    try:
        from huggingface_hub import hf_hub_download
    except ImportError as e:
        raise ImportError('huggingface_hub is required for Piper voice presets (same stack as other HF model downloads)') from e

    return hf_hub_download(repo_id=PIPER_VOICES_REPO_ID, filename=filename, repo_type='model')


def ensure_piper_voice_cached(voice_key: str) -> str:
    """
    Download preset voice files into the Hugging Face Hub cache and return the ``.onnx`` path.

    Args:
        voice_key: Key from ``voices.json`` (e.g. ``en_US-lessac-medium``).

    Returns:
        Absolute path to the ``.onnx`` file.
    """
    manifest_path = _hf_hub_download('voices.json')
    with open(manifest_path, encoding='utf-8') as f:
        manifest: Dict[str, Any] = json.load(f)

    entry = manifest.get(voice_key)
    if not isinstance(entry, dict):
        raise ValueError(f'Unknown Piper voice preset: {voice_key!r}')

    files = entry.get('files')
    if not isinstance(files, dict):
        raise ValueError(f'Invalid Piper manifest entry for: {voice_key!r}')

    onnx_path: str | None = None
    for rel_path in files:
        if not isinstance(rel_path, str):
            continue
        if rel_path.endswith('MODEL_CARD'):
            continue
        if not (rel_path.endswith('.onnx') or rel_path.endswith('.onnx.json')):
            continue

        local = _hf_hub_download(rel_path)

        if rel_path.endswith('.onnx') and not rel_path.endswith('.onnx.json'):
            onnx_path = local

    if not onnx_path:
        raise ValueError(f'No .onnx file listed for Piper voice: {voice_key!r}')
    return onnx_path
