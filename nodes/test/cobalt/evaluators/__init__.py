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

"""Shim package that re-exports the canonical evaluators from the eval_cobalt node.

The evaluator logic now lives in `nodes/src/nodes/eval_cobalt/evaluators/`
as a first-class component of the Cobalt evaluator node. This shim keeps
the experiment test files in `test/cobalt/experiments/` working without
rewriting their imports: they can continue to do
`from evaluators.relevance import evaluate_relevance`.
"""

import os
import sys

# Ensure the node-package evaluators are importable by adding the nodes/src/nodes
# directory to sys.path. This mirrors the pattern used by test/nodes/test_eval_cobalt.py.
_NODES_DIR = os.path.normpath(os.path.join(os.path.dirname(__file__), '..', '..', '..', 'nodes', 'src', 'nodes'))
if _NODES_DIR not in sys.path:
    sys.path.insert(0, _NODES_DIR)

from eval_cobalt.evaluators import STOP_WORDS  # noqa: E402, F401 — re-export for experiments

__all__ = ['STOP_WORDS']
