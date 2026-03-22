# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
SQL injection prevention tests for vectordb_postgres.

Verifies that the _sanitize_identifier function properly
rejects malicious table names.
"""

import sys
from pathlib import Path

import pytest

# Add nodes src to path
NODES_SRC = Path(__file__).parent.parent / 'src' / 'nodes'
sys.path.insert(0, str(NODES_SRC))

from vectordb_postgres.vectordb_postgres import _sanitize_identifier


class TestSanitizeIdentifier:
    """Tests for SQL identifier sanitization."""

    def test_valid_simple_name(self):
        assert _sanitize_identifier('my_collection') == '"my_collection"'

    def test_valid_uppercase(self):
        assert _sanitize_identifier('ROCKETRIDE') == '"ROCKETRIDE"'

    def test_valid_mixed_case(self):
        assert _sanitize_identifier('MyTable_123') == '"MyTable_123"'

    def test_rejects_empty_string(self):
        with pytest.raises(ValueError, match='Invalid SQL identifier'):
            _sanitize_identifier('')

    def test_rejects_sql_injection_semicolon(self):
        with pytest.raises(ValueError, match='Invalid SQL identifier'):
            _sanitize_identifier('users; DROP TABLE users--')

    def test_rejects_sql_injection_quotes(self):
        with pytest.raises(ValueError, match='Invalid SQL identifier'):
            _sanitize_identifier('users" OR "1"="1')

    def test_rejects_spaces(self):
        with pytest.raises(ValueError, match='Invalid SQL identifier'):
            _sanitize_identifier('my table')

    def test_rejects_leading_number(self):
        with pytest.raises(ValueError, match='Invalid SQL identifier'):
            _sanitize_identifier('123table')

    def test_rejects_special_chars(self):
        with pytest.raises(ValueError, match='Invalid SQL identifier'):
            _sanitize_identifier('table$name')

    def test_rejects_newlines(self):
        with pytest.raises(ValueError, match='Invalid SQL identifier'):
            _sanitize_identifier('table\nname')
