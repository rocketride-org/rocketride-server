# =============================================================================
# MIT License
# Copyright (c) 2026 RocketRide
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================

import base64
import json
import os

from rocketlib import IInstanceBase, AVI_ACTION, warning
from .IGlobal import IGlobal


def _infer_output_format(want_audio: bool, want_text: bool, engine: str) -> str:
    """Determine the audio encoding from connected output lanes and engine constraints.

    Encoding is driven by wiring, not by a node settings field:

    - **Audio lane connected:** WAV for broadest player/pipeline compatibility.
      (OpenAI can produce WAV; ElevenLabs is the exception below.)
    - **Text lane only:** MP3 for a smaller base64 payload.
    - **ElevenLabs (any wiring):** always MP3 — the API only returns MPEG audio.

    Args:
        want_audio: ``True`` when the ``audio`` output lane has a downstream
            connection.
        want_text: ``True`` when the ``text`` output lane has a downstream
            connection.
        engine: Canonical engine name (e.g. ``'elevenlabs'``, ``'piper'``).

    Returns:
        ``'mp3'`` or ``'wav'``.
    """
    eng = (engine or 'piper').lower().strip()
    if eng == 'elevenlabs':
        return 'mp3'
    if want_audio:
        return 'wav'
    return 'mp3'


class IInstance(IInstanceBase):
    IGlobal: IGlobal

    def writeText(self, text: str):
        """Synthesize the incoming text and emit the audio on the audio and/or text lanes.

        Determines which output lanes are wired, infers the audio format, calls
        ``IGlobal.synthesize``, reads the temp file once, streams raw bytes on
        the ``audio`` lane (``BEGIN`` / ``WRITE`` / ``END``), and/or emits a
        JSON payload with ``mime_type`` and ``base64`` on the ``text`` lane.
        The temp file is always deleted in the ``finally`` block.

        Empty or whitespace-only input is silently skipped.  When neither lane
        is connected a warning is logged and synthesis is skipped entirely.

        Args:
            text: Plain-text utterance received from the upstream node.

        Raises:
            Exception: Propagates any synthesis failure after logging a warning,
                so the pipeline execution layer can handle it appropriately.
        """
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

            # Refresh merged config for format/logging only — do **not** assign to ``IGlobal._config``
            # here: ``synthesize`` must see the *previous* effective engine to dispose/recreate
            # ``TTSEngine`` when switching (e.g. OpenAI → Kokoro). Pre-stomping _config made
            # old_engine == new_engine and left the old engine instance/caches in place.
            cfg_now = self.IGlobal._build_tts_config_dict()
            eng = str(cfg_now.get('engine', '') or '').strip()
            out_fmt = _infer_output_format(want_audio, want_text, eng)
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
