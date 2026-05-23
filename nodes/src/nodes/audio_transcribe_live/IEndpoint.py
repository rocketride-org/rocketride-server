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

import uuid
from typing import Any, Callable, Dict

from rocketlib import IEndpointBase, debug, getObject, monitorStatus

from .IGlobal import IGlobal


class IEndpoint(IEndpointBase):
    """
    Source endpoint that captures microphone audio and streams partial text.

    When the pipeline task starts, ``scanObjects`` opens a long-running session,
    reads from the default microphone, and forwards incremental ``text`` lane
    output to downstream nodes.
    """

    target: IEndpointBase | None = None
    _transcriber: Any | None = None
    _global: IGlobal | None = None

    def _resolve_global(self) -> IGlobal:
        global_ctx = IGlobal.active()
        if global_ctx is not None and getattr(global_ctx, '_whisper', None) is not None:
            return global_ctx

        fallback = IGlobal()
        fallback.ensure_initialized(dict(self.endpoint.serviceConfig))
        return fallback

    def _build_transcriber(self, global_ctx: IGlobal):
        from .live_transcribe import LiveTranscriber

        config = global_ctx.config or {}
        device = config.get('device', -1)
        try:
            device = int(device)
        except (TypeError, ValueError):
            device = -1

        return LiveTranscriber(
            transcribe=global_ctx.transcribe,
            chunk_interval=config.get('chunk_interval', 1.5),
            window_seconds=config.get('window_seconds', 4.0),
            device=device,
            silence_reset_seconds=config.get('silence_reset_seconds', 1.0),
        )

    def _register_scan_session(self, scanCallback: Callable[[Dict[str, Any]], int]):
        """Register a synthetic scanned object so the engine scan counter is non-zero."""
        try:
            scanCallback(
                {
                    'name': 'live_stt_session',
                    'isContainer': False,
                    'size': 0,
                }
            )
        except Exception as exc:
            debug(f'Live STT: scan callback error: {exc}')

    def beginEndpoint(self):
        """Prepare Whisper and microphone settings before scanning."""
        self._global = self._resolve_global()
        self._transcriber = self._build_transcriber(self._global)

    def endEndpoint(self):
        """Stop microphone capture when the endpoint shuts down."""
        if self._transcriber is not None:
            self._transcriber.stop()
            self._transcriber = None
        self._global = None

    def scanObjects(self, _path: str, scanCallback: Callable[[Dict[str, Any]], int]):
        """
        Start live microphone transcription for the duration of the pipeline task.

        Blocks until the task is stopped or the endpoint is shut down.
        """
        self.target = self.endpoint.target
        global_ctx = self._global or self._resolve_global()
        transcriber = self._transcriber or self._build_transcriber(global_ctx)

        # Mic sources do not scan files. Containers are not counted by the engine,
        # so register a zero-byte object before the blocking capture loop.
        self._register_scan_session(scanCallback)

        entry = getObject(
            obj={
                'url': f'live_stt://session/{uuid.uuid4()}',
                'name': 'live_stt_session',
            }
        )

        pipe = None
        try:
            pipe = self.target.getPipe()
            pipe.open(entry)
            monitorStatus('Live STT: session started — speak into your microphone')
            transcriber.run(pipe)
        except Exception as exc:
            debug(f'Live STT: session error: {exc}')
            raise
        finally:
            transcriber.stop()
            if pipe is not None:
                try:
                    pipe.close()
                except Exception as exc:
                    debug(f'Live STT: pipe close error: {exc}')
                self.target.putPipe(pipe)
            monitorStatus('Live STT: session stopped')
