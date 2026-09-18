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

"""The experiments' `evaluators` shim must point at the real eval_cobalt package.

Regression for the review finding that `_NODES_DIR` resolved to
`nodes/nodes/src/nodes` (one `nodes` segment too many), which does not exist.
"""

import os
import sys

import pytest

_COBALT_TEST_DIR = os.path.dirname(os.path.abspath(__file__))


@pytest.fixture
def shim():
    """Import the shim fresh so its sys.path side effect is observed here."""
    if _COBALT_TEST_DIR not in sys.path:
        sys.path.append(_COBALT_TEST_DIR)
    sys.modules.pop('evaluators', None)
    import evaluators  # noqa: PLC0415 -- the import is the behaviour under test

    return evaluators


def test_shim_nodes_dir_exists_and_is_the_node_package_root(shim):
    assert os.path.isdir(shim._NODES_DIR), shim._NODES_DIR
    assert shim._NODES_DIR.endswith(os.path.join('nodes', 'src', 'nodes'))
    assert os.path.isdir(os.path.join(shim._NODES_DIR, 'eval_cobalt', 'evaluators'))


def test_shim_re_exports_the_node_evaluators(shim):
    from evaluators.relevance import evaluate_relevance  # same import the experiments use

    assert callable(evaluate_relevance)
    assert shim.STOP_WORDS
