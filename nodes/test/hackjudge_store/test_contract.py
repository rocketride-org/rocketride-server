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

"""hackjudge_store contract: the op surface other nodes and the app rely on."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from hackjudge_common_stubs import import_node_module  # noqa: E402

inst = import_node_module('hackjudge_store', 'IInstance')

OPS = (
    'targets_list',
    'targets_create',
    'targets_update',
    'targets_delete',
    'runs_create',
    'runs_finish',
    'runs_list',
    'runs_get',
    'results_append',
    'balance_get',
    'usage_append',
)


class Contract(unittest.TestCase):
    def test_all_documented_ops_have_handlers(self):
        for op in OPS:
            self.assertTrue(hasattr(inst.IInstance, '_op_' + op), op)

    def test_unknown_op_has_no_handler(self):
        # dispatch is getattr('_op_' + op): anything undocumented must miss
        self.assertFalse(hasattr(inst.IInstance, '_op_drop_all_tables'))


if __name__ == '__main__':
    unittest.main()
