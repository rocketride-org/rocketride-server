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
    def test_missing_returns_none(self):
        assert parse_working_dir({}) is None

    def test_strips_whitespace(self):
        assert parse_working_dir({'workingDir': '  /tmp  '}) == '/tmp'

    def test_empty_string_returns_none(self):
        assert parse_working_dir({'workingDir': '   '}) is None


class TestParseTimeout:
    def test_missing_returns_default(self):
        assert parse_timeout({}) == DEFAULT_TIMEOUT

    def test_valid_value(self):
        assert parse_timeout({'timeout': 60}) == 60

    def test_string_numeric_accepted(self):
        assert parse_timeout({'timeout': '120'}) == 120

    def test_clamps_above_max(self):
        assert parse_timeout({'timeout': MAX_TIMEOUT * 10}) == MAX_TIMEOUT

    def test_clamps_below_min(self):
        assert parse_timeout({'timeout': 0}) == 1
        assert parse_timeout({'timeout': -5}) == 1

    def test_invalid_falls_back_to_default(self):
        assert parse_timeout({'timeout': 'not-a-number'}) == DEFAULT_TIMEOUT
        assert parse_timeout({'timeout': None}) == DEFAULT_TIMEOUT


class TestParseMaxOutput:
    def test_missing_returns_default(self):
        assert parse_max_output({}) == DEFAULT_MAX_OUTPUT_BYTES

    def test_enforces_minimum(self):
        # Below 1 KiB should be clamped up to 1024.
        assert parse_max_output({'maxOutputBytes': 100}) == 1024

    def test_passes_through_large_values(self):
        assert parse_max_output({'maxOutputBytes': 5 * 1024 * 1024}) == 5 * 1024 * 1024

    def test_invalid_falls_back_to_default(self):
        assert parse_max_output({'maxOutputBytes': 'huge'}) == DEFAULT_MAX_OUTPUT_BYTES


class TestParseEnvVars:
    def test_missing_returns_empty(self):
        assert parse_env_vars({}) == {}

    def test_parses_array_of_rows(self):
        cfg = {
            'envVars': [
                {'envName': 'FOO', 'envValue': 'bar'},
                {'envName': 'BAZ', 'envValue': 'qux'},
            ],
        }
        assert parse_env_vars(cfg) == {'FOO': 'bar', 'BAZ': 'qux'}

    def test_skips_blank_names(self):
        cfg = {
            'envVars': [
                {'envName': '   ', 'envValue': 'ignored'},
                {'envName': 'KEEP', 'envValue': 'yes'},
            ],
        }
        assert parse_env_vars(cfg) == {'KEEP': 'yes'}

    def test_coerces_value_to_string(self):
        cfg = {'envVars': [{'envName': 'N', 'envValue': 42}]}
        assert parse_env_vars(cfg) == {'N': '42'}

    def test_accepts_json_encoded_array_string(self):
        cfg = {'envVars': '[{"envName": "X", "envValue": "y"}]'}
        assert parse_env_vars(cfg) == {'X': 'y'}

    def test_malformed_json_returns_empty(self):
        assert parse_env_vars({'envVars': 'not json'}) == {}

    def test_skips_non_dict_rows(self):
        cfg = {'envVars': ['not-a-dict', {'envName': 'OK', 'envValue': 'v'}]}
        assert parse_env_vars(cfg) == {'OK': 'v'}


class TestParseCommandPatterns:
    def test_missing_returns_empty(self):
        assert parse_command_patterns({}) == []

    def test_compiles_valid_regexes(self):
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
        cfg = {'commandAllowlist': [{'commandPattern': '  '}, {'commandPattern': '^echo'}]}
        patterns = parse_command_patterns(cfg)
        assert len(patterns) == 1

    def test_accepts_json_encoded_array_string(self):
        cfg = {'commandAllowlist': '[{"commandPattern": "^echo"}]'}
        patterns = parse_command_patterns(cfg)
        assert len(patterns) == 1
        assert patterns[0].search('echo hi')

    def test_malformed_json_returns_empty(self):
        assert parse_command_patterns({'commandAllowlist': 'nope'}) == []
