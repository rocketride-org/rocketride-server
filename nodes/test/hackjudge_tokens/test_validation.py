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

"""hackjudge_tokens input validation: rejects that must fire before any DB work.

`_op_settle` validates its input before touching the instance, so the unbound
method runs with ``self=None``: reaching the database would raise instantly,
which is exactly the property under test.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from hackjudge_common_stubs import import_node_module  # noqa: E402

inst = import_node_module('hackjudge_tokens', 'IInstance')


class SettleValidation(unittest.TestCase):
    def test_negative_kb_rejected_before_db(self):
        res = inst.IInstance._op_settle(None, {'tenant_id': 't1', 'kb_processed': -5})
        self.assertFalse(res['ok'])
        self.assertIn('>= 0', res['error'])

    def test_non_numeric_kb_rejected_before_db(self):
        res = inst.IInstance._op_settle(None, {'tenant_id': 't1', 'kb_processed': 'lots'})
        self.assertFalse(res['ok'])
        self.assertIn('number', res['error'])


class OpTable(unittest.TestCase):
    def test_all_documented_ops_have_handlers(self):
        for op in ('gate', 'settle', 'credit', 'config', 'balance'):
            self.assertTrue(hasattr(inst.IInstance, '_op_' + op), op)


if __name__ == '__main__':
    unittest.main()
