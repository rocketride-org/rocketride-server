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

from rocketlib import IGlobalBase, OPEN_MODE, warning
from ai.common.config import Config


class IGlobal(IGlobalBase):
    config = None
    engine = None
    nonce_fencer = None

    def beginGlobal(self):
        # Are we in config mode or some other mode?
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            # We are going to get a call to configureService but
            # we don't actually need to load the engine for that
            pass
        else:
            import os
            from depends import depends  # type: ignore

            # Load the requirements (no external deps, but follow the pattern)
            requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
            depends(requirements)

            # Get the configuration
            self.config = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)

            # Create the guardrails engine
            from .guardrails_engine import GuardrailsEngine

            self.engine = GuardrailsEngine(self.config)

            # Create the nonce fencer when enabled
            if self.config.get('enable_nonce_fencing', False):
                from .nonce_fencer import NonceFencer

                nonce_length = self.config.get('nonce_length', 16)
                if not isinstance(nonce_length, int) or nonce_length < 16:
                    warning(f'[Guardrails] nonce_length must be integer >= 16, got {nonce_length!r}; using 16')
                    nonce_length = 16
                elif nonce_length > 128:
                    warning(f'[Guardrails] nonce_length must be <= 128, got {nonce_length}; using 128')
                    nonce_length = 128

                self.nonce_fencer = NonceFencer(nonce_length=nonce_length)

    def endGlobal(self):
        # Clean up resources
        self.engine = None
        self.nonce_fencer = None
        self.config = None
