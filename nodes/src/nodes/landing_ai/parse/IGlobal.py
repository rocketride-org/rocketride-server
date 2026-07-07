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

from rocketlib import IGlobalBase, debug, warning

from ..landing_ai_base import ensure_dependencies, get_node_config, validate_credentials


class IGlobal(IGlobalBase):
    """Global configuration for the Landing.ai Parse node."""

    def __init__(self):
        """Declare instance attributes; heavy initialization happens in beginGlobal."""
        super().__init__()
        self.parser = None

    def beginGlobal(self):
        """Install dependencies and build the shared parser instance."""
        debug('Landing.ai Parse Global: starting global initialization')

        ensure_dependencies()

        from .parse import Parser

        bag = self.IEndpoint.endpoint.bag
        self.parser = Parser(self.glb.logicalType, self.glb.connConfig, bag)
        debug('Landing.ai Parse Global: parser initialized')

    def validateConfig(self):
        """Validate config + credentials with a live ADE call (warn-only, like the LLM nodes)."""
        try:
            ensure_dependencies()
            config = get_node_config(self.glb.logicalType, self.glb.connConfig)
            err = validate_credentials(config)
            if err:
                warning(f'Landing.ai Parse: {err}')
        except Exception as e:  # noqa: BLE001 — warn-only; never block canvas editing
            warning(f'Landing.ai Parse: {e}')

    def endGlobal(self):
        """Clean up resources when global configuration is being destroyed."""
        debug('Landing.ai Parse Global: cleanup')
        self.parser = None
