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


class IGlobal(IGlobalBase):
    segmenter = None
    device_lock = None

    def beginGlobal(self):
        """Build the shared Segmenter facade from node config (mode/model/threshold/maxEdge/prompt)."""
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return

        # pycocotools is needed client-side for RLE restore + overlay rendering,
        # even when inference is proxied to the model server.
        from depends import load_depends

        load_depends(__file__)

        from ai.common.models.vision.segmentation import (
            Segmenter,
            DEFAULT_MODE,
            MODES,
            PROMPT_MODES,
            DEFAULT_THRESHOLD,
            DEFAULT_MAX_EDGE,
        )

        config = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
        conn = self.glb.connConfig

        mode = str(config.get('mode', DEFAULT_MODE)).lower().strip()
        if mode not in MODES:
            warning(f'detect_segment: unknown mode "{mode}", falling back to {DEFAULT_MODE}.')
            mode = DEFAULT_MODE

        # UI field values arrive prefixed under connConfig['parameters']; see
        # Config.resolve_node_param for the full story.
        params = conn.get('parameters')
        ui_prompt = params.get('detect_segment.prompt') if params is not None else None
        prompt = str(
            ui_prompt or conn.get('detect_segment.prompt') or conn.get('prompt') or config.get('prompt') or ''
        ).strip()
        if mode in PROMPT_MODES and not prompt:
            raise ValueError(
                f'detect_segment: mode "{mode}" requires a non-empty prompt (detect_segment.prompt). '
                'Set a concept prompt in the UI (e.g. "yellow school bus") and restart the pipeline.'
            )

        model_name = (config.get('model') or '').strip() or None
        # Resolve threshold with None-checks so a valid 0.0 is not dropped.
        raw_threshold = Config.resolve_node_param(conn, config, 'detect_segment', 'threshold', DEFAULT_THRESHOLD)
        try:
            threshold = float(raw_threshold)
        except (TypeError, ValueError):
            threshold = None
        if threshold is None or not (0.0 <= threshold <= 1.0):
            warning(f'detect_segment: invalid threshold {raw_threshold!r}, using default {DEFAULT_THRESHOLD}')
            threshold = DEFAULT_THRESHOLD
        raw_max_edge = Config.resolve_node_param(conn, config, 'detect_segment', 'maxEdge', DEFAULT_MAX_EDGE)
        try:
            max_edge = int(raw_max_edge)
        except (TypeError, ValueError):
            max_edge = DEFAULT_MAX_EDGE
        max_edge = min(4096, max(256, max_edge))

        revision = (config.get('revision') or '').strip() or None

        self.segmenter = Segmenter(
            mode=mode,
            model_name=model_name,
            device=None,
            threshold=threshold,
            max_edge=max_edge,
            prompt=prompt or None,
            revision=revision,
        )

        # Local inference must serialize GPU access
        from ai.common.models.base import make_device_lock

        self.device_lock = make_device_lock()

    def endGlobal(self):
        """Disconnect the facade and release shared state on teardown."""
        if self.segmenter is not None:
            try:
                self.segmenter.disconnect()
            except Exception as exc:
                warning(f'detect_segment: error during teardown, ignoring: {exc}')
        self.segmenter = None
        self.device_lock = None
