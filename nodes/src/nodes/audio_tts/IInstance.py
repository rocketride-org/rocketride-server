# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
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

import os

from rocketlib import IInstanceBase, AVI_ACTION, warning
from .IGlobal import IGlobal


def _infer_output_format(engine: str) -> str:
    """Determine the audio container format from the engine.

    ElevenLabs always returns MPEG audio from its API; all other engines
    produce WAV.

    Args:
        engine: Canonical engine name (e.g. ``'elevenlabs'``, ``'piper'``).

    Returns:
        ``'mp3'`` for ElevenLabs; ``'wav'`` for all other engines.
    """
    return 'mp3' if (engine or '').lower().strip() == 'elevenlabs' else 'wav'


class IInstance(IInstanceBase):
    IGlobal: IGlobal

    def writeText(self, text: str):
        """Synthesize the incoming text and stream the audio on the audio lane.

        Calls ``IGlobal.synthesize``, reads the temp file, and streams
        container-format bytes via ``writeAudio`` (BEGIN / WRITE / END).
        The temp file is always deleted in the ``finally`` block.

        Empty or whitespace-only input is silently skipped.

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
            cfg_now = self.IGlobal._build_tts_config_dict()
            eng = str(cfg_now.get('engine', '') or '').strip()
            out_fmt = _infer_output_format(eng)
            payload = self.IGlobal.synthesize(value, out_fmt)
            temp_path = payload.get('path')

            with open(temp_path, 'rb') as fin:
                raw = fin.read()

            mime = payload.get('mime_type', 'audio/wav')
            self.instance.writeAudio(AVI_ACTION.BEGIN, mime)
            self.instance.writeAudio(AVI_ACTION.WRITE, mime, raw)
            self.instance.writeAudio(AVI_ACTION.END, mime)
        except Exception as e:
            warning(f'TTS synthesis failed: {e}')
            raise
        finally:
            if temp_path:
                try:
                    os.remove(temp_path)
                except OSError:
                    pass
