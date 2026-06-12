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
from rocketlib import IGlobalBase, debug, warning
from ai.common.config import Config


class IGlobal(IGlobalBase):
    """Global (per-pipeline-run) state for the LandingAI ADE node."""

    def __init__(self):
        """Declare instance attributes; heavy initialization happens in beginGlobal."""
        super().__init__()
        self.parser = None

    def beginGlobal(self):
        """Initialize the parser once per pipeline run (shared across instances)."""
        debug('LandingAI ADE Global: Starting global initialization')

        self.ensureDependencies()

        # Import the helper lazily — its vendor SDK is only importable after
        # ensureDependencies() has installed requirements.txt.
        from .parser import Parser

        bag = self.IEndpoint.endpoint.bag
        self.parser = Parser(self.glb.logicalType, self.glb.connConfig, bag)
        debug('LandingAI ADE Global: Parser initialized')

    def validateConfig(self):
        """Validate config at canvas save-time.

        This runs while the user edits the node on the canvas, so it only ever
        warns — it never raises and never touches the network.
        """
        config = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
        if 'default' in config:
            config = config.get('default', {})

        api_key = (config.get('api_key') or '').strip() or os.environ.get('VISION_AGENT_API_KEY')
        if not api_key:
            warning(
                'LandingAI ADE: No API key provided — set the API Key field or the '
                'VISION_AGENT_API_KEY environment variable.'
            )

        region = config.get('region', 'production')
        if region not in ('production', 'eu'):
            warning(f'LandingAI ADE: Unknown region "{region}"; expected "production" or "eu".')

    def ensureDependencies(self):
        """Install the node's Python requirements (idempotent / cached by depends)."""
        from depends import depends

        requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
        depends(requirements)

    def endGlobal(self):
        """Release the parser (and the API key it holds) at run teardown."""
        debug('LandingAI ADE Global: Cleanup')
        self.parser = None
