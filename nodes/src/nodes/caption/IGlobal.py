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

import threading

from rocketlib import IGlobalBase, OPEN_MODE
from ai.common.config import Config


class IGlobal(IGlobalBase):
    captioner = None
    device_lock = None

    def beginGlobal(self):
        """Build the shared Captioner facade from node config (model/task)."""
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return

        from ai.common.models.vision.caption import Captioner, DEFAULT_MODEL, DEFAULT_TASK

        config = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)

        model_name = (config.get('model') or '').strip() or DEFAULT_MODEL
        task = str(config.get('task', DEFAULT_TASK)).strip() or DEFAULT_TASK
        revision = (config.get('revision') or '').strip() or None

        # device=None -> model server when --modelserver is set, else local.
        self.captioner = Captioner(model_name=model_name, device=None, task=task, revision=revision)
        self.device_lock = threading.Lock()

    def endGlobal(self):
        """Disconnect the facade and release shared state on teardown."""
        if self.captioner is not None:
            self.captioner.disconnect()
        self.captioner = None
        self.device_lock = None
