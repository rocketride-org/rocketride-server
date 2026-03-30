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

# ------------------------------------------------------------------------------
# This class controls the data shared between all threads for the task
# ------------------------------------------------------------------------------
import os
from rocketlib import IGlobalBase, OPEN_MODE, warning
from ai.common.config import Config

from .hybrid_search import HybridSearchEngine


class IGlobal(IGlobalBase):
    engine: HybridSearchEngine | None = None
    top_k: int = 10
    rrf_k: int = 60

    def validateConfig(self):
        """Validate that the rank_bm25 dependency is available."""
        try:
            from depends import depends

            requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
            depends(requirements)
        except Exception as e:
            warning(str(e))

    def beginGlobal(self):
        # Are we in config mode or some other mode?
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            # We are going to get a call to configureService but
            # we don't actually need to load the engine for that
            pass
        else:
            # Get this node's config
            config = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)

            # Read parameters from config
            alpha = float(config.get('alpha', 0.5))
            self.top_k = int(config.get('top_k', 10))
            self.rrf_k = int(config.get('rrf_k', 60))

            # Validate alpha range
            alpha = max(0.0, min(1.0, alpha))

            # Create the hybrid search engine
            self.engine = HybridSearchEngine(alpha=alpha)

    def endGlobal(self):
        # Release the engine
        self.engine = None
