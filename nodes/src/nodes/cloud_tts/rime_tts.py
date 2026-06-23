# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Rime TTS HTTPS call. Returns MP3 bytes; raises on a non-2xx response."""

_RIME_TTS_URL = 'https://users.rime.ai/v1/rime-tts'
_HTTP_TIMEOUT_SEC = 120


def synthesize(text: str, model: str, voice: str, api_key: str) -> bytes:
    """POST text to the Rime endpoint and return MP3 bytes.

    ``voice`` is the Rime speaker and ``model`` the Rime ``modelId``; Rime
    speakers are model-specific, so the caller must pass a speaker valid for the
    model. Output format is selected by the ``Accept`` header (Rime has no body
    format field), so this always requests MP3.
    """
    import requests  # lazy

    payload = {'text': text, 'speaker': voice, 'modelId': model}
    headers = {'Authorization': f'Bearer {api_key}', 'Content-Type': 'application/json', 'Accept': 'audio/mpeg'}
    response = requests.post(_RIME_TTS_URL, json=payload, headers=headers, timeout=_HTTP_TIMEOUT_SEC)
    response.raise_for_status()
    return response.content
