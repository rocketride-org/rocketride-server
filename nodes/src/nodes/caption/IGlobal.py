# =============================================================================
# MIT License
#
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

from rocketlib import IGlobalBase, OPEN_MODE, warning
from ai.common.config import Config


DEFAULT_PROMPT = 'Describe this image in detail.'
DEFAULT_MAX_NEW_TOKENS = 256
DEFAULT_MAX_SENTENCES = 0  # 0 disables the sentence-boundary stop


class IGlobal(IGlobalBase):
    captioner = None
    device_lock = None
    prompt = DEFAULT_PROMPT
    max_new_tokens = DEFAULT_MAX_NEW_TOKENS

    def beginGlobal(self):
        """Build the shared Captioner facade from node config (model/prompt)."""
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return

        from ai.common.models.vision.caption import Captioner, DEFAULT_MODEL

        config = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
        conn = self.glb.connConfig

        model_name = (config.get('model') or '').strip()
        if not model_name:
            warning(f'caption: no model configured, using default {DEFAULT_MODEL}')
            model_name = DEFAULT_MODEL
        # UI field values arrive prefixed under connConfig['parameters']; see
        # Config.resolve_node_param for the full story.
        params = conn.get('parameters')
        ui_prompt = params.get('caption.prompt') if params is not None else None
        self.prompt = (
            str(
                ui_prompt or conn.get('caption.prompt') or conn.get('prompt') or config.get('prompt') or DEFAULT_PROMPT
            ).strip()
            or DEFAULT_PROMPT
        )
        # Resolve max_new_tokens with None-checks so a set value of 0 falls
        # through to validation (and the default) rather than being skipped.
        raw_max_tokens = Config.resolve_node_param(conn, config, 'caption', 'max_new_tokens', DEFAULT_MAX_NEW_TOKENS)
        try:
            max_new_tokens = int(raw_max_tokens)
        except (TypeError, ValueError):
            max_new_tokens = None
        if max_new_tokens is None or not (1 <= max_new_tokens <= 1024):
            warning(f'caption: invalid max_new_tokens {raw_max_tokens!r}, using default {DEFAULT_MAX_NEW_TOKENS}')
            max_new_tokens = DEFAULT_MAX_NEW_TOKENS
        self.max_new_tokens = max_new_tokens
        # max_sentences: stop generation at a clean sentence boundary; 0 disables.
        raw_max_sentences = Config.resolve_node_param(conn, config, 'caption', 'max_sentences', DEFAULT_MAX_SENTENCES)
        try:
            max_sentences = int(raw_max_sentences)
        except (TypeError, ValueError):
            max_sentences = None
        if max_sentences is None or not (0 <= max_sentences <= 16):
            warning(f'caption: invalid max_sentences {raw_max_sentences!r}, using default {DEFAULT_MAX_SENTENCES}')
            max_sentences = DEFAULT_MAX_SENTENCES
        revision = (config.get('revision') or '').strip() or None

        # Profile-provided GPU allocation size (4B profiles set ~10-11 GB; the
        # loader falls back to its small-model default when absent).
        extra = {}
        memory_gb = config.get('memory_gb')
        if memory_gb:
            extra['memory_gb'] = float(memory_gb)

        # device=None -> model server when --modelserver is set, else local.
        self.captioner = Captioner(
            model_name=model_name,
            device=None,
            revision=revision,
            max_sentences=max_sentences or None,
            **extra,
        )

        # Local inference must serialize GPU access
        from ai.common.models.base import make_device_lock

        self.device_lock = make_device_lock()

    def endGlobal(self):
        """Disconnect the facade and release shared state on teardown."""
        if self.captioner is not None:
            self.captioner.disconnect()
        self.captioner = None
        self.device_lock = None
