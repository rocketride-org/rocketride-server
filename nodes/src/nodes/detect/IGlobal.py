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

from rocketlib import IGlobalBase
from ai.common.models.base import make_device_lock
from ai.common.models.vision.detection import OPEN_VOCAB_BACKENDS, Detector


class IGlobal(IGlobalBase):
    detector = None
    device_lock = None

    def beginGlobal(self):
        """Build the shared Detector facade from the resolved config.

        The selected profile pins the backend engine; the threshold is bounded
        by the schema and the prompt exists only on the open-vocabulary branch,
        where the schema requires it. The class split still guards against a
        prompt made of separators only.
        """
        config = self.config

        backend = config.engine
        prompt = (config.get('prompt') or '').strip()
        classes = [c.strip() for c in prompt.replace('.', ',').split(',') if c.strip()]
        if backend in OPEN_VOCAB_BACKENDS and not classes:
            raise ValueError(
                f'detect: engine "{backend}" requires a non-empty prompt. '
                'Set a prompt in the UI (e.g. "person . car . dog") and restart the pipeline.'
            )

        self.detector = Detector(backend=backend, device=None, threshold=config.threshold, prompt=prompt or None)

        # Local inference must serialize GPU access
        self.device_lock = make_device_lock()

    def endGlobal(self):
        """Disconnect the facade and release shared state on teardown."""
        if self.detector is not None:
            self.detector.disconnect()
        self.detector = None
        self.device_lock = None
