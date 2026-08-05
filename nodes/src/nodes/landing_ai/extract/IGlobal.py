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

from ..landing_ai_base import ensure_dependencies, get_node_config, load_schema_from_data_url, validate_credentials


class IGlobal(IGlobalBase):
    """Global configuration for the Landing.ai Extract node."""

    def __init__(self):
        """Declare instance attributes; heavy initialization happens in beginGlobal."""
        super().__init__()
        self.extractor = None

    def beginGlobal(self):
        """Install dependencies and build the shared extractor instance."""
        debug('Landing.ai Extract Global: starting global initialization')

        ensure_dependencies()

        from .extract import Extractor

        self.extractor = Extractor(self.glb.logicalType, self.glb.connConfig)
        debug('Landing.ai Extract Global: extractor initialized')

    def validateConfig(self):
        """Validate config + credentials with a live ADE call (warn-only, like the LLM nodes)."""
        try:
            ensure_dependencies()
            config = get_node_config(self.glb.logicalType, self.glb.connConfig)

            err = validate_credentials(config)
            if err:
                warning(f'Landing.ai Extract: {err}')

            schema_file = config.get('schema_file', '')
            if not schema_file:
                warning('Landing.ai Extract: no extraction schema uploaded')
            else:
                try:
                    load_schema_from_data_url(schema_file)
                except ValueError as e:
                    warning(f'Landing.ai Extract: {e}')
        except Exception as e:  # noqa: BLE001 — warn-only; never block canvas editing
            warning(f'Landing.ai Extract: {e}')

    def endGlobal(self):
        """Clean up resources when global configuration is being destroyed."""
        debug('Landing.ai Extract Global: cleanup')
        self.extractor = None
