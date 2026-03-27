# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

import base64
import json
import os

from rocketlib import IInstanceBase, AVI_ACTION, warning
from .IGlobal import IGlobal


def _infer_output_format(want_audio: bool, want_text: bool, engine: str) -> str:
    """
    File encoding is chosen from wiring, not from node settings.
    - Audio lane: prefer WAV for broad player / pipeline compatibility (OpenAI can emit WAV).
    - Text-only: prefer MP3 for smaller base64 JSON.
    - ElevenLabs: our client always receives MPEG from the API, so keep MP3.
    """
    eng = (engine or 'piper').lower()
    if eng == 'elevenlabs':
        return 'mp3'
    if want_audio:
        return 'wav'
    return 'mp3'


class IInstance(IInstanceBase):
    IGlobal: IGlobal

    def writeText(self, text: str):
        value = (text or '').strip()
        if not value:
            return

        temp_path: str | None = None
        try:
            want_audio = self.instance.hasListener('audio')
            want_text = self.instance.hasListener('text')
            if not want_audio and not want_text:
                warning('TTS: no downstream connection on audio or text lane; skipping synthesis')
                return

            out_fmt = _infer_output_format(want_audio, want_text, self.IGlobal._config.get('engine', ''))
            payload = self.IGlobal.synthesize(value, out_fmt)
            temp_path = payload.get('path')

            raw: bytes | None = None
            if want_audio or want_text:
                with open(temp_path, 'rb') as fin:
                    raw = fin.read()

            if want_audio and raw is not None:
                mime = payload.get('mime_type', 'audio/wav')
                self.instance.writeAudio(AVI_ACTION.BEGIN, mime)
                self.instance.writeAudio(AVI_ACTION.WRITE, mime, raw)
                self.instance.writeAudio(AVI_ACTION.END, mime)

            if want_text and raw is not None:
                # Server-side temp paths are not downloadable URLs; consumers use base64 or the audio lane.
                text_payload = {
                    'mime_type': payload.get('mime_type', 'audio/wav'),
                    'base64': base64.b64encode(raw).decode('ascii'),
                }
                self.instance.writeText(json.dumps(text_payload))
        except Exception as e:
            warning(f'TTS synthesis failed: {e}')
            # Do not swallow synthesis failures; propagate to pipeline execution.
            raise
        finally:
            if temp_path:
                try:
                    os.remove(temp_path)
                except OSError:
                    pass
