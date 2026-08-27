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

"""Password handling in hackjudge_account: the part that must never be wrong."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from hackjudge_common_stubs import import_node_module  # noqa: E402

inst = import_node_module('hackjudge_account', 'IInstance')


class Passwords(unittest.TestCase):
    def test_roundtrip(self):
        stored = inst._hash_password('correct horse battery staple')
        self.assertTrue(inst._verify_password('correct horse battery staple', stored))

    def test_wrong_password_rejected(self):
        stored = inst._hash_password('right')
        self.assertFalse(inst._verify_password('wrong', stored))
        self.assertFalse(inst._verify_password('', stored))

    def test_salts_differ_per_hash(self):
        a = inst._hash_password('same input')
        b = inst._hash_password('same input')
        self.assertNotEqual(a, b, 'two hashes of one password must not collide (fresh salt each)')

    def test_stored_format_records_parameters(self):
        stored = inst._hash_password('x')
        self.assertTrue(stored.startswith('scrypt$'))
        # scheme, n, r, p, salt, digest: parameters travel with the hash so they
        # can be raised later without breaking existing accounts
        self.assertEqual(len(stored.split('$')), 6)

    def test_garbage_stored_value_rejected_not_raised(self):
        self.assertFalse(inst._verify_password('anything', 'not-a-hash'))


class OpTable(unittest.TestCase):
    def test_all_documented_ops_have_handlers(self):
        for op in ('signup', 'signin', 'validate', 'signout', 'profile_get', 'profile_update'):
            self.assertTrue(hasattr(inst.IInstance, '_op_' + op), op)


if __name__ == '__main__':
    unittest.main()
