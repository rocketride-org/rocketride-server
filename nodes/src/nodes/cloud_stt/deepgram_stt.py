# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Deepgram pre-recorded transcription HTTPS call.

Verified directly against Deepgram's own reference (developers.deepgram.com),
not paraphrased: POST the raw audio bytes as the request body (Content-Type
set to the audio's mime type), options as query params, ``Authorization:
Token <key>`` — not Bearer. Returns the transcript string; raises on a
non-2xx response or a response body missing the expected transcript field.
"""

_DEEPGRAM_LISTEN_URL = 'https://api.deepgram.com/v1/listen'
_HTTP_TIMEOUT_SEC = 120


def transcribe(
    audio: bytes, mime_type: str, *, model: str, language: str, smart_format: bool, punctuate: bool, api_key: str
) -> str:
    """POST ``audio`` to Deepgram's /v1/listen and return the transcript text."""
    import requests  # lazy

    params = {
        'model': model,
        'language': language,
        'smart_format': 'true' if smart_format else 'false',
        'punctuate': 'true' if punctuate else 'false',
    }
    headers = {
        'Authorization': f'Token {api_key}',
        'Content-Type': mime_type or 'application/octet-stream',
    }
    response = requests.post(
        _DEEPGRAM_LISTEN_URL, params=params, headers=headers, data=audio, timeout=_HTTP_TIMEOUT_SEC
    )
    response.raise_for_status()
    body = response.json()

    try:
        return body['results']['channels'][0]['alternatives'][0]['transcript']
    except (KeyError, IndexError, TypeError) as exc:
        raise ValueError(f'Deepgram response missing the expected transcript field: {exc}') from exc
