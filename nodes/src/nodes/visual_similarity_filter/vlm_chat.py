# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Lightweight Ollama REST client for the VLM Similarity Filter node.

Sends a prompt and up to two images to a locally-running Ollama instance
and parses the response as a YES/NO boolean.  Uses the /api/chat endpoint
(required for Qwen2.5-VL multi-image support — /api/generate returns empty
responses for vision models with multiple images).
"""

import base64
import datetime
import io
import threading
from typing import Optional

_LOG = '/tmp/brandy_pipeline.log'
_MAX_IMAGE_SIDE = 960  # resize images to at most this dimension before sending


def _plog(msg: str) -> None:
    line = f'[{datetime.datetime.now().isoformat(timespec="milliseconds")}] [vlm_filter   ] {msg}\n'
    with open(_LOG, 'a') as f:
        f.write(line)


def _resize(img_bytes: bytes, max_side: int = _MAX_IMAGE_SIDE) -> bytes:
    """Resize image so its longest side is at most max_side pixels.

    Returns JPEG bytes.  Falls back to original bytes if PIL is unavailable
    or the image is already within the size limit.
    """
    try:
        from PIL import Image

        img = Image.open(io.BytesIO(img_bytes)).convert('RGB')
        if max(img.size) > max_side:
            ratio = max_side / max(img.size)
            new_w = max(1, int(img.width * ratio))
            new_h = max(1, int(img.height * ratio))
            img = img.resize((new_w, new_h), Image.LANCZOS)
        buf = io.BytesIO()
        img.save(buf, 'JPEG', quality=85)
        return buf.getvalue()
    except Exception as e:
        _plog(f'_resize: skipped ({e}), using original bytes')
        return img_bytes


def _format_ollama_error(model: str, base_url: str, exc: Exception) -> str:
    """Convert Ollama exception into a user-friendly message (mirrors llm_vision_ollama pattern)."""
    msg = str(exc).lower()
    if any(p in msg for p in ['connection refused', 'connection error', 'failed to connect', 'cannot connect']):
        return f'Cannot connect to Ollama server at {base_url}. Is Ollama running?'
    if any(p in msg for p in ['model not found', 'no such model', '404']):
        return f"Model '{model}' is not loaded in Ollama. Run: ollama pull {model}"
    if any(p in msg for p in ['timeout', 'timed out']):
        return f"Ollama request timed out. Model '{model}' may need more time — try increasing timeout."
    return f'Ollama error: {exc}'


class VLMChat:
    """Thin wrapper around the Ollama /api/chat endpoint.

    Uses the chat messages format required by Qwen2.5-VL for multi-image
    vision tasks.  Supports 0, 1, or 2 images per request.
    """

    def __init__(self, model: str, ollama_url: str, timeout: float = 30.0):
        """Initialize with model name, Ollama base URL, and per-request timeout."""
        self._model = model
        self._base_url = ollama_url.rstrip('/')
        self._url = self._base_url + '/api/chat'
        self._timeout = timeout

    def describe(self, prompt: str, images: Optional[list] = None) -> str:
        """Send prompt + images, return raw text response (not parsed as YES/NO).

        Used to generate a free-text description of the reference image.
        Returns an empty string on any error.
        """
        import requests

        resized = [_resize(img) for img in (images or [])]
        b64_images = [base64.b64encode(img).decode() for img in resized]

        message: dict = {'role': 'user', 'content': prompt}
        if b64_images:
            message['images'] = b64_images

        payload = {
            'model': self._model,
            'messages': [message],
            'stream': False,
        }

        result = [None]
        exc = [None]

        def _call():
            try:
                r = requests.post(self._url, json=payload, timeout=self._timeout)
                r.raise_for_status()
                data = r.json()
                content = (data.get('message', {}).get('content', '') or data.get('response', '')).strip()
                result[0] = content
            except Exception as e:
                exc[0] = e

        t = threading.Thread(target=_call, daemon=True)
        t.start()
        t.join(timeout=self._timeout + 5)

        if t.is_alive() or exc[0]:
            friendly = _format_ollama_error(self._model, self._base_url, exc[0] or TimeoutError('timeout'))
            _plog(f'describe: FAILED — {friendly}')
            return ''

        text = result[0] or ''
        _plog(f'describe: {text!r:.120}')
        return text

    def ask(self, prompt: str, images: Optional[list] = None) -> bool:
        """POST prompt + images to Ollama, return True if response starts with YES.

        Args:
            prompt: instruction text sent to the model.
            images: list of raw image bytes (0, 1, or 2 items).

        Returns:
            True if the model answers YES, False on NO or any error.
        """
        import requests

        resized = [_resize(img) for img in (images or [])]
        b64_images = [base64.b64encode(img).decode() for img in resized]

        message: dict = {'role': 'user', 'content': prompt}
        if b64_images:
            message['images'] = b64_images

        payload = {
            'model': self._model,
            'messages': [
                {
                    'role': 'system',
                    'content': ('You are a binary visual classifier. You MUST respond with exactly one word: YES or NO. Do not explain, describe, or add any other text.'),
                },
                message,
            ],
            'stream': False,
        }

        result = [None]
        exc = [None]

        def _call():
            try:
                r = requests.post(self._url, json=payload, timeout=self._timeout)
                r.raise_for_status()
                data = r.json()
                # /api/chat response: {"message": {"role": "assistant", "content": "..."}}
                content = (
                    data.get('message', {}).get('content', '') or data.get('response', '')  # fallback for older Ollama builds
                ).strip()
                result[0] = content
            except Exception as e:
                exc[0] = e

        t = threading.Thread(target=_call, daemon=True)
        t.start()
        t.join(timeout=self._timeout + 5)

        if t.is_alive():
            friendly = _format_ollama_error(self._model, self._base_url, TimeoutError(f'timed out after {self._timeout}s'))
            _plog(f'ask: {friendly} → False')
            return False
        if exc[0]:
            friendly = _format_ollama_error(self._model, self._base_url, exc[0])
            _plog(f'ask: {friendly} → False')
            return False

        raw = result[0] or ''
        matched = raw.upper().startswith('YES')
        _plog(f'ask: response={raw!r:.120} → {matched}')
        return matched
