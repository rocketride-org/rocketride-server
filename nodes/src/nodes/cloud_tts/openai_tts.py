# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""OpenAI TTS HTTPS call. Returns MP3 bytes; raises on a non-2xx response."""

_OPENAI_TTS_URL = 'https://api.openai.com/v1/audio/speech'
_HTTP_TIMEOUT_SEC = 120


def synthesize(text: str, model: str, voice: str, api_key: str) -> bytes:
    """POST text/speech to the OpenAI audio endpoint and return MP3 bytes."""
    import requests  # lazy

    payload = {'model': model, 'voice': voice, 'input': text, 'response_format': 'mp3'}
    headers = {'Authorization': f'Bearer {api_key}', 'Content-Type': 'application/json'}
    response = requests.post(_OPENAI_TTS_URL, json=payload, headers=headers, timeout=_HTTP_TIMEOUT_SEC)
    response.raise_for_status()
    return response.content
