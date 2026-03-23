# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
SQL injection prevention tests for vectordb_postgres.

Verifies that the VALID_TABLE regex properly rejects malicious table names
used in SQL format strings.
"""

import sys
from pathlib import Path

# Add nodes src to path
NODES_SRC = Path(__file__).parent.parent / 'src' / 'nodes'
sys.path.insert(0, str(NODES_SRC))

from vectordb_postgres.IGlobal import VALID_TABLE


class TestValidTable:
    """Tests for SQL table name validation via VALID_TABLE regex."""

    def test_valid_simple_name(self):
        assert VALID_TABLE.fullmatch('my_collection')

    def test_valid_uppercase(self):
        assert VALID_TABLE.fullmatch('ROCKETRIDE')

    def test_valid_mixed_case(self):
        assert VALID_TABLE.fullmatch('MyTable_123')

    def test_valid_underscore_prefix(self):
        assert VALID_TABLE.fullmatch('_internal')

    def test_rejects_empty_string(self):
        assert not VALID_TABLE.fullmatch('')

    def test_rejects_sql_injection_semicolon(self):
        assert not VALID_TABLE.fullmatch('users; DROP TABLE users--')

    def test_rejects_sql_injection_quotes(self):
        assert not VALID_TABLE.fullmatch('users" OR "1"="1')

    def test_rejects_spaces(self):
        assert not VALID_TABLE.fullmatch('my table')

    def test_rejects_leading_number(self):
        assert not VALID_TABLE.fullmatch('123table')

    def test_rejects_special_chars(self):
        assert not VALID_TABLE.fullmatch('table$name')

    def test_rejects_newlines(self):
        assert not VALID_TABLE.fullmatch('table\nname')

    def test_rejects_too_long_name(self):
        assert not VALID_TABLE.fullmatch('a' * 64)

    def test_accepts_max_length_name(self):
        assert VALID_TABLE.fullmatch('a' * 63)
