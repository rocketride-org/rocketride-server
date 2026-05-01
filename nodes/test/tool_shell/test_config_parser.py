# =============================================================================
# MIT License
# Copyright (c) 2024 RocketRide Inc.
# =============================================================================

"""Unit tests for tool_shell config parsing."""

from __future__ import annotations

import sys
from pathlib import Path

# Add the node source directory to sys.path so we can import the helper
# module without triggering the top-level nodes/__init__.py.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent / 'src' / 'nodes' / 'tool_shell'))

from config_parser import (  # noqa: E402
    DEFAULT_MAX_OUTPUT_BYTES,
    DEFAULT_TIMEOUT,
    MAX_TIMEOUT,
    parse_command_patterns,
    parse_env_vars,
    parse_max_output,
    parse_timeout,
    parse_working_dir,
)


class TestParseWorkingDir:
    """parse_working_dir."""

    def test_missing_returns_none(self):
        """Missing key returns None."""
        assert parse_working_dir({}) is None

    def test_strips_whitespace(self):
        """Surrounding whitespace is trimmed."""
        assert parse_working_dir({'workingDir': '  /tmp  '}) == '/tmp'

    def test_empty_string_returns_none(self):
        """Whitespace-only value collapses to None."""
        assert parse_working_dir({'workingDir': '   '}) is None


class TestParseTimeout:
    """parse_timeout."""

    def test_missing_returns_default(self):
        """Missing key falls back to DEFAULT_TIMEOUT."""
        assert parse_timeout({}) == DEFAULT_TIMEOUT

    def test_valid_value(self):
        """Valid integer is returned as-is."""
        assert parse_timeout({'timeout': 60}) == 60

    def test_string_numeric_accepted(self):
        """Numeric strings are coerced."""
        assert parse_timeout({'timeout': '120'}) == 120

    def test_clamps_above_max(self):
        """Values above MAX_TIMEOUT are clamped down."""
        assert parse_timeout({'timeout': MAX_TIMEOUT * 10}) == MAX_TIMEOUT

    def test_clamps_below_min(self):
        """Zero or negative values are clamped up to 1."""
        assert parse_timeout({'timeout': 0}) == 1
        assert parse_timeout({'timeout': -5}) == 1

    def test_invalid_falls_back_to_default(self):
        """Non-numeric/None values fall back to DEFAULT_TIMEOUT."""
        assert parse_timeout({'timeout': 'not-a-number'}) == DEFAULT_TIMEOUT
        assert parse_timeout({'timeout': None}) == DEFAULT_TIMEOUT


class TestParseMaxOutput:
    """parse_max_output."""

    def test_missing_returns_default(self):
        """Missing key falls back to DEFAULT_MAX_OUTPUT_BYTES."""
        assert parse_max_output({}) == DEFAULT_MAX_OUTPUT_BYTES

    def test_enforces_minimum(self):
        """Values below 1 KiB are clamped up to 1024."""
        assert parse_max_output({'maxOutputBytes': 100}) == 1024

    def test_passes_through_large_values(self):
        """Large values are returned unchanged."""
        assert parse_max_output({'maxOutputBytes': 5 * 1024 * 1024}) == 5 * 1024 * 1024

    def test_invalid_falls_back_to_default(self):
        """Non-numeric values fall back to DEFAULT_MAX_OUTPUT_BYTES."""
        assert parse_max_output({'maxOutputBytes': 'huge'}) == DEFAULT_MAX_OUTPUT_BYTES


class TestParseEnvVars:
    """parse_env_vars."""

    def test_missing_returns_empty(self):
        """Missing key yields an empty dict."""
        assert parse_env_vars({}) == {}

    def test_parses_array_of_rows(self):
        """Each well-formed row becomes a name/value pair."""
        cfg = {
            'envVars': [
                {'envName': 'FOO', 'envValue': 'bar'},
                {'envName': 'BAZ', 'envValue': 'qux'},
            ],
        }
        assert parse_env_vars(cfg) == {'FOO': 'bar', 'BAZ': 'qux'}

    def test_skips_blank_names(self):
        """Rows with empty/whitespace envName are dropped."""
        cfg = {
            'envVars': [
                {'envName': '   ', 'envValue': 'ignored'},
                {'envName': 'KEEP', 'envValue': 'yes'},
            ],
        }
        assert parse_env_vars(cfg) == {'KEEP': 'yes'}

    def test_coerces_value_to_string(self):
        """Non-string values are stringified."""
        cfg = {'envVars': [{'envName': 'N', 'envValue': 42}]}
        assert parse_env_vars(cfg) == {'N': '42'}

    def test_preserves_falsy_non_none_values(self):
        """0/False/'' are preserved instead of collapsing to empty."""
        cfg = {
            'envVars': [
                {'envName': 'ZERO', 'envValue': 0},
                {'envName': 'FLAG', 'envValue': False},
                {'envName': 'EMPTY', 'envValue': ''},
            ],
        }
        assert parse_env_vars(cfg) == {'ZERO': '0', 'FLAG': 'False', 'EMPTY': ''}

    def test_none_value_becomes_empty_string(self):
        """None-valued rows produce an empty string."""
        cfg = {'envVars': [{'envName': 'NIL', 'envValue': None}]}
        assert parse_env_vars(cfg) == {'NIL': ''}

    def test_accepts_json_encoded_array_string(self):
        """JSON-string array form is parsed transparently."""
        cfg = {'envVars': '[{"envName": "X", "envValue": "y"}]'}
        assert parse_env_vars(cfg) == {'X': 'y'}

    def test_malformed_json_returns_empty(self):
        """Malformed JSON falls back to empty."""
        assert parse_env_vars({'envVars': 'not json'}) == {}

    def test_skips_non_dict_rows(self):
        """Non-mapping rows are ignored."""
        cfg = {'envVars': ['not-a-dict', {'envName': 'OK', 'envValue': 'v'}]}
        assert parse_env_vars(cfg) == {'OK': 'v'}


class TestParseCommandPatterns:
    """parse_command_patterns."""

    def test_missing_returns_empty(self):
        """Missing key yields an empty pattern list."""
        assert parse_command_patterns({}) == []

    def test_compiles_valid_regexes(self):
        """All compilable regexes appear in the result."""
        cfg = {
            'commandAllowlist': [
                {'commandPattern': r'^npm '},
                {'commandPattern': r'^git status'},
            ],
        }
        patterns = parse_command_patterns(cfg)
        assert len(patterns) == 2
        assert patterns[0].search('npm install lodash')
        assert patterns[1].search('git status')
        assert not patterns[1].search('git push')

    def test_invalid_regex_reported_and_skipped(self):
        """Compile failures invoke on_invalid and are skipped."""
        warnings: list[str] = []
        cfg = {
            'commandAllowlist': [
                {'commandPattern': r'(unbalanced'},
                {'commandPattern': r'^ls$'},
            ],
        }
        patterns = parse_command_patterns(cfg, on_invalid=warnings.append)
        assert len(patterns) == 1
        assert patterns[0].search('ls')
        assert len(warnings) == 1
        assert 'unbalanced' in warnings[0]

    def test_skips_blank_patterns(self):
        """Blank/whitespace patterns are skipped."""
        cfg = {'commandAllowlist': [{'commandPattern': '  '}, {'commandPattern': '^echo'}]}
        patterns = parse_command_patterns(cfg)
        assert len(patterns) == 1

    def test_accepts_json_encoded_array_string(self):
        """JSON-string array form is parsed transparently."""
        cfg = {'commandAllowlist': '[{"commandPattern": "^echo"}]'}
        patterns = parse_command_patterns(cfg)
        assert len(patterns) == 1
        assert patterns[0].search('echo hi')

    def test_malformed_json_returns_empty(self):
        """Malformed JSON falls back to empty."""
        assert parse_command_patterns({'commandAllowlist': 'nope'}) == []
