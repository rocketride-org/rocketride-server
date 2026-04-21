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

"""Global state for the Cobalt Evaluator node.

Manages the shared CobaltEvaluator instance across all threads for the
current pipeline execution.
"""

import os

from rocketlib import IGlobalBase, OPEN_MODE, warning
from ai.common.config import Config


class IGlobal(IGlobalBase):
    _evaluator = None

    def validateConfig(self):
        """Save-time validation for the Cobalt Evaluator node.

        Checks that cobalt-ai can be loaded and that LLM judge mode has
        an API key configured.
        """
        try:
            from depends import depends

            requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
            depends(requirements)

            config = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
            eval_type = config.get('eval_type', 'similarity')

            if eval_type == 'llm_judge':
                apikey = config.get('apikey', '')
                if not apikey:
                    warning('API key required for LLM judge evaluator')
                    return

            # Validate threshold is within bounds
            threshold = config.get('threshold', 0.7)
            try:
                threshold = float(threshold)
                if threshold < 0.0 or threshold > 1.0:
                    warning('Threshold must be between 0.0 and 1.0')
                    return
            except (ValueError, TypeError):
                warning('Threshold must be a valid number between 0.0 and 1.0')
                return

        except Exception as e:  # noqa: BLE001 - validation surfaces dependency/config failures as warnings
            warning(str(e))

    def beginGlobal(self):
        """Initialize the evaluator for pipeline execution.

        In CONFIG mode this is a no-op. Otherwise loads dependencies and
        creates a CobaltEvaluator instance from the node configuration.
        """
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            pass
        else:
            from depends import depends

            requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
            depends(requirements)

            from .cobalt_evaluator import CobaltEvaluator

            config = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
            bag = self.IEndpoint.endpoint.bag
            self._evaluator = CobaltEvaluator(config, bag)

    def endGlobal(self):
        """Release the evaluator instance."""
        self._evaluator = None
