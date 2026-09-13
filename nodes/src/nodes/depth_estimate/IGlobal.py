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

# Bounds for the input long-edge: default, and the clamp range applied to maxEdge.
DEFAULT_MAX_EDGE = 1024
MIN_MAX_EDGE = 256
MAX_MAX_EDGE = 4096


class IGlobal(IGlobalBase):
    estimator = None
    device_lock = None
    max_edge = DEFAULT_MAX_EDGE

    def beginGlobal(self):
        """Build the shared DepthEstimator facade and parse the clamped maxEdge config."""
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return

        from ai.common.models.vision.depth import DepthEstimator, DEFAULT_MODEL

        conn = self.glb.connConfig
        # UI field values arrive prefixed under connConfig['parameters']; see
        # Config.resolve_node_param / Config.resolve_node_config for the full story.
        node_cfg = Config.resolve_node_config(self.glb.logicalType, conn, 'depth_estimate')

        # max_edge: bound input resolution so inference cost stays predictable.
        raw_max_edge = Config.resolve_node_param(conn, node_cfg, 'depth_estimate', 'maxEdge', DEFAULT_MAX_EDGE)
        try:
            self.max_edge = int(raw_max_edge)
        except (TypeError, ValueError):
            self.max_edge = DEFAULT_MAX_EDGE
        self.max_edge = min(MAX_MAX_EDGE, max(MIN_MAX_EDGE, self.max_edge))

        raw_model = Config.resolve_node_param(conn, node_cfg, 'depth_estimate', 'model')
        model_name = (raw_model or '').strip()
        if not model_name:
            warning(f'depth_estimate: no model configured, using default {DEFAULT_MODEL}')
            model_name = DEFAULT_MODEL
        revision = (node_cfg.get('revision') or '').strip() or None
        # A custom model override must not inherit the profile's pinned revision.
        if raw_model and node_cfg.get('model') and model_name != str(node_cfg.get('model')).strip():
            revision = None

        # device=None -> model server when --modelserver is set, else local.
        self.estimator = DepthEstimator(model_name, device=None, revision=revision)

        # Local inference must serialize GPU access
        from ai.common.models.base import make_device_lock

        self.device_lock = make_device_lock()

    def endGlobal(self):
        """Disconnect the facade and release shared state on teardown."""
        if self.estimator is not None:
            self.estimator.disconnect()
        self.estimator = None
        self.device_lock = None
