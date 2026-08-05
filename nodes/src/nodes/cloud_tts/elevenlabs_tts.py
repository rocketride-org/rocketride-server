# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""ElevenLabs TTS HTTPS call. Returns MP3 bytes; raises on a non-2xx response."""

_ELEVENLABS_TTS_URL = 'https://api.elevenlabs.io/v1/text-to-speech/{voice}'
_HTTP_TIMEOUT_SEC = 120


def synthesize(text: str, model: str, voice: str, api_key: str) -> bytes:
    """POST text to the ElevenLabs endpoint (voice in the path) and return MP3 bytes."""
    import requests  # lazy

    url = _ELEVENLABS_TTS_URL.format(voice=voice)
    payload = {'text': text, 'model_id': model}
    headers = {'xi-api-key': api_key, 'Content-Type': 'application/json', 'Accept': 'audio/mpeg'}
    response = requests.post(url, json=payload, headers=headers, timeout=_HTTP_TIMEOUT_SEC)
    response.raise_for_status()
    return response.content
