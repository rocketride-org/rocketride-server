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
from rocketlib import IGlobalBase

from .hybrid_search import HybridSearchEngine


class IGlobal(IGlobalBase):
    """Hold shared hybrid-search state across all node threads."""

    engine: HybridSearchEngine | None = None
    top_k: int = 10
    rrf_k: int = 60

    def beginGlobal(self):
        """Create the hybrid search engine from the resolved config.

        The schema bounds alpha to [0, 1], top_k to >= 1 and rrf_k to >= 0,
        so the values are read as they are.
        """
        config = self.config
        self.top_k = int(config.top_k)
        self.rrf_k = int(config.rrf_k)
        self.engine = HybridSearchEngine(alpha=float(config.alpha))

    def endGlobal(self):
        """Release shared search state."""
        self.engine = None
