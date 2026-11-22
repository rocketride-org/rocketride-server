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

"""
Global handler for the Context Optimizer node.

The model, its window override and the four budget percentages are per-call
parameters: each call builds its own (cheap) optimizer from its settings. The
control keeps the one thing every call shares, the snapshot of the engine's
model context windows, read from the service registry once per pipeline start.
"""

import os

from rocketlib import IGlobalBase

from .optimizer import ContextOptimizer, ModelCatalog


class IGlobal(IGlobalBase):
    """IGlobal for the Context Optimizer node: the model-window catalog."""

    catalog: ModelCatalog | None = None

    def beginGlobal(self):
        """Install the tokenizer and snapshot the engine's model windows."""
        # Load the requirements (tiktoken)
        from depends import depends  # type: ignore

        requirements = os.path.join(os.path.dirname(os.path.realpath(__file__)), 'requirements.txt')
        depends(requirements)

        # One registry read per control; every call's optimizer budgets against it
        self.catalog = ContextOptimizer.load_catalog()

    def endGlobal(self):
        """Release the catalog."""
        self.catalog = None
