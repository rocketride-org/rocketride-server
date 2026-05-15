"""
Tests for Milvus filter expression injection prevention.

Validates that the _escape_milvus_str helper properly sanitizes
user-controlled values before they are interpolated into Milvus
filter expressions, preventing filter injection attacks.
"""

import sys
import os
import unittest
from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'src', 'nodes', 'milvus'))

# Mock heavy dependencies only for the duration of the milvus import so that
# real modules (numpy, ai.*) remain available to other test files collected in
# the same pytest session.
with patch.dict(
    sys.modules,
    {
        'numpy': MagicMock(),
        'pymilvus': MagicMock(),
    },
):
    from milvus import _escape_milvus_str


class TestEscapeMilvusStr(unittest.TestCase):
    """Tests for the _escape_milvus_str sanitization helper."""

    def test_normal_string_unchanged(self):
        self.assertEqual(_escape_milvus_str('hello'), 'hello')

    def test_empty_string(self):
        self.assertEqual(_escape_milvus_str(''), '')

    def test_numeric_string(self):
        self.assertEqual(_escape_milvus_str('12345'), '12345')

    def test_single_quote_escaped(self):
        result = _escape_milvus_str("it's")
        self.assertEqual(result, "it\\'s")

    def test_backslash_escaped(self):
        result = _escape_milvus_str('a\\b')
        self.assertEqual(result, 'a\\\\b')

    def test_backslash_before_quote(self):
        result = _escape_milvus_str("a\\'")
        self.assertEqual(result, "a\\\\\\'")

    def test_non_string_converted(self):
        result = _escape_milvus_str(42)
        self.assertEqual(result, '42')


class TestFilterInjectionPrevention(unittest.TestCase):
    """
    Tests that common injection payloads are neutralized.

    These tests verify the escape function produces output that,
    when placed inside single-quoted Milvus filter expressions,
    cannot break out of the string boundary.
    """

    def test_inject_always_true_condition(self):
        payload = "' || true || '"
        result = _escape_milvus_str(payload)
        self.assertEqual(result, "\\' || true || \\'")

    def test_inject_bypass_isdeleted_filter(self):
        payload = "x' || meta['isDeleted'] == true || 'x"
        result = _escape_milvus_str(payload)
        self.assertEqual(result, "x\\' || meta[\\'isDeleted\\'] == true || \\'x")
        filter_expr = f"meta['nodeId'] == '{result}'"
        self.assertTrue(filter_expr.startswith("meta['nodeId'] == '"))
        self.assertTrue(filter_expr.endswith("'"))

    def test_inject_cross_tenant_access(self):
        payload = "' || meta['tenantId'] != '' || '"
        result = _escape_milvus_str(payload)
        filter_expr = f"meta['objectId'] == '{result}'"
        self.assertEqual(filter_expr, "meta['objectId'] == '\\' || meta[\\'tenantId\\'] != \\'\\' || \\''")

    def test_inject_read_deleted_documents(self):
        payload = "anything' || meta['isDeleted'] == False || '"
        result = _escape_milvus_str(payload)
        self.assertFalse(
            result.endswith("'") and not result.endswith("\\'"), 'Unescaped trailing quote would allow injection'
        )

    def test_inject_via_keyword_search(self):
        payload = "%' || 1==1 || content like '%"
        result = _escape_milvus_str(payload)
        filter_expr = f"content like '%{result}%'"
        self.assertNotIn('|| 1==1', filter_expr.replace(_escape_milvus_str('|| 1==1'), ''))

    def test_inject_via_list_element(self):
        payload = "id1', 'injected_id"
        result = _escape_milvus_str(payload)
        list_expr = f"'{result}'"
        self.assertEqual(list_expr.count("'") - list_expr.count("\\'"), 2)


if __name__ == '__main__':
    unittest.main()
