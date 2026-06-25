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
    detector = None
    device_lock = None

    def beginGlobal(self):
        """Build the shared Detector facade from node config; validate the open-vocab prompt."""
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return

        from ai.common.models.vision.detection import (
            Detector,
            DEFAULT_BACKEND,
            BACKENDS,
            OPEN_VOCAB_BACKENDS,
            DEFAULT_THRESHOLD,
        )

        config = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
        conn = self.glb.connConfig

        backend = str(config.get('engine', DEFAULT_BACKEND)).lower().strip()
        if backend not in BACKENDS:
            warning(f'detect: unknown engine "{backend}", defaulting to {DEFAULT_BACKEND}')
            backend = DEFAULT_BACKEND

        prompt = (config.get('prompt') or conn.get('detect.prompt') or conn.get('prompt') or '').strip()
        # Check threshold
        raw_threshold = conn.get('detect.threshold', config.get('threshold', DEFAULT_THRESHOLD))
        try:
            threshold = float(raw_threshold)
        except (TypeError, ValueError):
            threshold = None
        if threshold is None or not (0.0 <= threshold <= 1.0):
            warning(f'detect: invalid threshold {raw_threshold!r}, using default {DEFAULT_THRESHOLD}')
            threshold = DEFAULT_THRESHOLD

        classes = [c.strip() for c in prompt.replace('.', ',').split(',') if c.strip()]
        if backend in OPEN_VOCAB_BACKENDS and not classes:
            raise ValueError(
                f'detect: engine "{backend}" requires a non-empty prompt (detect.prompt). '
                'Set a prompt in the UI (e.g. "person . car . dog") and restart the pipeline.'
            )

        revision = (config.get('revision') or '').strip() or None

        self.detector = Detector(
            backend=backend, device=None, threshold=threshold, prompt=prompt or None, revision=revision
        )

        # Local inference must serialize GPU access
        from ai.common.models.base import make_device_lock

        self.device_lock = make_device_lock()

    def endGlobal(self):
        """Disconnect the facade and release shared state on teardown."""
        if self.detector is not None:
            self.detector.disconnect()
        self.detector = None
        self.device_lock = None
