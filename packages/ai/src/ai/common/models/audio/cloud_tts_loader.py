# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Cloud TTS loaders for the RocketRide model server.

OpenAI and ElevenLabs do not download weights to the host; inference runs on the vendor API.
Routing through the model server centralizes egress, keeps API keys on the server host,
and matches the pattern used for other TTS backends when ``--modelserver`` is set.

CPU-only (``gpu_index=-1``); returns ``audio_base64`` + ``mime_type`` per item.
"""

from __future__ import annotations

import base64
import json
import urllib.error
import urllib.request
from urllib.parse import quote
from typing import Any, Dict, List, Optional, Tuple


from ..base import BaseLoader


def _mime_for_openai_format(fmt: str) -> str:
    """Return the MIME type string for the given OpenAI audio format name."""
    f = (fmt or 'mp3').lower()
    return {
        'mp3': 'audio/mpeg',
        'opus': 'audio/opus',
        'aac': 'audio/aac',
        'flac': 'audio/flac',
        'wav': 'audio/wav',
        'pcm': 'audio/L16',
    }.get(f, 'audio/mpeg')


class OpenAITTSLoader(BaseLoader):
    """Proxy OpenAI ``/v1/audio/speech`` on the model server."""

    LOADER_TYPE: str = 'openai_tts'
    _REQUIREMENTS_FILE: Optional[str] = None
    _DEFAULTS: dict = {'voice': 'alloy'}

    @staticmethod
    def load(
        model_name: str,
        device: Optional[str] = None,
        allocate_gpu: Optional[callable] = None,
        exclude_gpus: Optional[List[int]] = None,
        api_key: Optional[str] = None,
        voice: str = 'alloy',
        **kwargs,
    ) -> Tuple[Any, Dict[str, Any], int]:
        """Build the OpenAI TTS credential bundle; no weights are downloaded."""
        if not api_key:
            raise ValueError('OpenAITTSLoader requires api_key')

        bundle = {
            'api_key': api_key,
            'voice': voice,
            'model': model_name,
        }
        metadata = {
            'loader': 'openai_tts',
            'model_name': model_name,
            'voice': voice,
            'estimated_memory_gb': 0.01,
            'device': 'cpu',
        }
        return bundle, metadata, -1

    @staticmethod
    def preprocess(model: Any, inputs: List[Any], metadata: Optional[Dict] = None) -> Dict[str, Any]:
        """Normalize raw inputs into a list of row dicts with text, format, voice, and model fields."""
        rows: List[Dict[str, str]] = []
        for item in inputs:
            if isinstance(item, dict):
                rows.append(
                    {
                        'text': str(item.get('text', '')),
                        'output_format': str(item.get('output_format', 'mp3')).lower(),
                        'voice': str(item.get('voice', '') or '').strip(),
                        'model': str(item.get('model', '') or '').strip(),
                    }
                )
            else:
                rows.append({'text': str(item), 'output_format': 'mp3', 'voice': '', 'model': ''})
        return {'rows': rows}

    @staticmethod
    def inference(
        model: Any,
        preprocessed: Dict[str, Any],
        metadata: Optional[Dict] = None,
        stream: Optional[Any] = None,
    ) -> Any:
        """Call the OpenAI speech endpoint for each row and return base64-encoded audio items."""
        if hasattr(model, 'model_obj'):
            bundle = model.model_obj
        else:
            bundle = model

        rows = preprocessed.get('rows') or []
        api_key = bundle.get('api_key')
        voice = bundle.get('voice', 'alloy')
        model_id = bundle.get('model', 'gpt-4o-mini-tts')

        items: List[Dict[str, str]] = []
        for row in rows:
            fmt = row.get('output_format', 'mp3')
            row_voice = (row.get('voice') or '').strip() or voice
            row_model = (row.get('model') or '').strip() or model_id
            payload = json.dumps(
                {
                    'model': row_model,
                    'voice': row_voice,
                    'input': row.get('text', ''),
                    'response_format': fmt,
                }
            ).encode('utf-8')
            req = urllib.request.Request(
                'https://api.openai.com/v1/audio/speech',
                data=payload,
                headers={
                    'Authorization': f'Bearer {api_key}',
                    'Content-Type': 'application/json',
                },
                method='POST',
            )
            try:
                with urllib.request.urlopen(req, timeout=120) as resp:
                    raw = resp.read()
            except urllib.error.HTTPError as e:
                detail = e.read().decode('utf-8', errors='replace')
                raise RuntimeError(f'OpenAI TTS HTTP {e.code}: {detail}') from e
            items.append(
                {
                    'audio_base64': base64.b64encode(raw).decode('ascii'),
                    'mime_type': _mime_for_openai_format(fmt),
                }
            )
        return {'items': items}

    @staticmethod
    def postprocess(
        model: Any,
        raw_output: Any,
        batch_size: int,
        output_fields: List[str],
        **kwargs,
    ) -> List[Dict[str, Any]]:
        """Filter each inference item to only the requested output_fields."""
        items = raw_output.get('items') if isinstance(raw_output, dict) else None
        if not items:
            return [{} for _ in range(batch_size or 1)]
        results: List[Dict[str, Any]] = []
        for item in items:
            results.append({k: item[k] for k in output_fields if k in item})
        return results


class ElevenLabsTTSLoader(BaseLoader):
    """Proxy ElevenLabs ``text-to-speech/{voice}`` on the model server."""

    LOADER_TYPE: str = 'elevenlabs_tts'
    _REQUIREMENTS_FILE: Optional[str] = None
    _DEFAULTS: dict = {}

    @staticmethod
    def load(
        model_name: str,
        device: Optional[str] = None,
        allocate_gpu: Optional[callable] = None,
        exclude_gpus: Optional[List[int]] = None,
        api_key: Optional[str] = None,
        voice: str = '',
        **kwargs,
    ) -> Tuple[Any, Dict[str, Any], int]:
        """Build the ElevenLabs TTS credential bundle; no weights are downloaded."""
        if not api_key:
            raise ValueError('ElevenLabsTTSLoader requires api_key')
        if not voice:
            raise ValueError('ElevenLabsTTSLoader requires voice (id)')

        bundle = {
            'api_key': api_key,
            'voice': voice,
            'model': model_name,
        }
        metadata = {
            'loader': 'elevenlabs_tts',
            'model_name': model_name,
            'voice': voice,
            'estimated_memory_gb': 0.01,
            'device': 'cpu',
        }
        return bundle, metadata, -1

    @staticmethod
    def preprocess(model: Any, inputs: List[Any], metadata: Optional[Dict] = None) -> Dict[str, Any]:
        """Normalize raw inputs into a list of row dicts with text, voice, and model fields."""
        rows: List[Dict[str, str]] = []
        for item in inputs:
            if isinstance(item, dict):
                rows.append(
                    {
                        'text': str(item.get('text', '')),
                        'voice': str(item.get('voice', '') or '').strip(),
                        'model': str(item.get('model', '') or '').strip(),
                    }
                )
            else:
                rows.append({'text': str(item), 'voice': '', 'model': ''})
        return {'rows': rows}

    @staticmethod
    def inference(
        model: Any,
        preprocessed: Dict[str, Any],
        metadata: Optional[Dict] = None,
        stream: Optional[Any] = None,
    ) -> Any:
        """Call the ElevenLabs TTS endpoint for each row and return base64-encoded audio items."""
        if hasattr(model, 'model_obj'):
            bundle = model.model_obj
        else:
            bundle = model

        rows = preprocessed.get('rows') or []
        api_key = bundle.get('api_key')
        voice = bundle.get('voice')
        model_id = bundle.get('model', 'eleven_multilingual_v2')

        items: List[Dict[str, str]] = []
        for row in rows:
            row_voice = (row.get('voice') or '').strip() or voice
            row_model = (row.get('model') or '').strip() or model_id
            vid = quote(row_voice, safe='')
            payload = json.dumps({'text': row.get('text', ''), 'model_id': row_model}).encode('utf-8')
            url = f'https://api.elevenlabs.io/v1/text-to-speech/{vid}'
            req = urllib.request.Request(
                url,
                data=payload,
                headers={
                    'xi-api-key': api_key,
                    'Content-Type': 'application/json',
                    'Accept': 'audio/mpeg',
                },
                method='POST',
            )
            try:
                with urllib.request.urlopen(req, timeout=120) as resp:
                    raw = resp.read()
            except urllib.error.HTTPError as e:
                detail = e.read().decode('utf-8', errors='replace')
                raise RuntimeError(f'ElevenLabs TTS HTTP {e.code}: {detail}') from e
            items.append(
                {
                    'audio_base64': base64.b64encode(raw).decode('ascii'),
                    'mime_type': 'audio/mpeg',
                }
            )
        return {'items': items}

    @staticmethod
    def postprocess(
        model: Any,
        raw_output: Any,
        batch_size: int,
        output_fields: List[str],
        **kwargs,
    ) -> List[Dict[str, Any]]:
        """Filter each inference item to only the requested output_fields."""
        items = raw_output.get('items') if isinstance(raw_output, dict) else None
        if not items:
            return [{} for _ in range(batch_size or 1)]
        results: List[Dict[str, Any]] = []
        for item in items:
            results.append({k: item[k] for k in output_fields if k in item})
        return results
