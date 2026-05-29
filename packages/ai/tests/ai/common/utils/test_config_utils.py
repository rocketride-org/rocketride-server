# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Unit tests for ``ai.common.utils.config_utils``:

* ``parse_bool`` — loose bool coercion for human-edited config values.
* ``config_int`` — bounded int reader from a config dict.

Important: ``parse_bool`` is intentionally **loose** (accepts ``"yes"`` /
``"true"`` / etc.) because it parses human-edited config files. The strict
counterpart for LLM-supplied tool args lives in ``ai.common.utils.tool_args``
as ``require_bool`` / ``optional_bool``. The strict / loose split is the
safety net against LLM hallucinations sneaking through as coerced strings.
The cross-check tests below assert the split holds.

Run with::

    pytest packages/ai/tests/ai/common/utils/test_config_utils.py -v
"""

from __future__ import annotations

import pytest

from ai.common.utils import config_int, parse_bool


# ---------------------------------------------------------------------------
# parse_bool — loose coercion for config files
# ---------------------------------------------------------------------------


class TestParseBool:
    def test_true_passes_through(self):
        assert parse_bool(True) is True

    def test_false_passes_through(self):
        assert parse_bool(False) is False

    def test_none_returns_default(self):
        assert parse_bool(None, default=True) is True
        assert parse_bool(None, default=False) is False

    def test_default_defaults_to_false(self):
        # No default supplied → False on absent / unrecognised input.
        assert parse_bool(None) is False
        assert parse_bool('maybe') is False

    # Truthy strings -----------------------------------------------------

    def test_truthy_strings(self):
        for s in ('1', 'true', 'yes', 'on', 'TRUE', 'Yes', ' yes ', 'ON'):
            assert parse_bool(s) is True, f'expected True for {s!r}'

    # Falsy strings ------------------------------------------------------

    def test_falsy_strings(self):
        for s in ('0', 'false', 'no', 'off', 'FALSE', 'No', ' off ', 'OFF'):
            assert parse_bool(s, default=True) is False, f'expected False for {s!r}'

    # Unrecognised strings ----------------------------------------------

    def test_unrecognised_string_returns_default(self):
        # Important contract: a garbage string is safer to treat as
        # "unspecified" than as truthy. Pin this — _get_bool's old
        # bool("garbage") == True behaviour would regress here.
        assert parse_bool('maybe', default=False) is False
        assert parse_bool('maybe', default=True) is True
        assert parse_bool('', default=False) is False
        assert parse_bool('', default=True) is True
        assert parse_bool('garbage', default=False) is False

    # Other types --------------------------------------------------------

    def test_int_uses_bool_coercion(self):
        # Numbers fall through to bool() — non-zero is True.
        assert parse_bool(1) is True
        assert parse_bool(0) is False
        assert parse_bool(-1) is True

    def test_list_uses_bool_coercion(self):
        assert parse_bool([1]) is True
        assert parse_bool([]) is False

    def test_dict_uses_bool_coercion(self):
        assert parse_bool({'a': 1}) is True
        assert parse_bool({}) is False


class TestParseBoolStrictnessCrossCheck:
    """Guards the strict / loose split between tool_args and config_utils.

    ``parse_bool`` (loose, this module) MUST accept ``"true"`` / ``"yes"``;
    ``require_bool`` / ``optional_bool`` (strict, ``ai.common.utils.tool_args``)
    MUST reject them. If a future refactor accidentally merges the two,
    one side of this test pair fails immediately.
    """

    def test_parse_bool_accepts_true_string(self):
        # The loose side: 'true' is normal in a YAML/JSON config typed by a human.
        assert parse_bool('true') is True
        assert parse_bool('yes') is True
        assert parse_bool('1') is True

    def test_require_bool_rejects_true_string(self):
        # The strict side: 'true' from an LLM is almost always a hallucination.
        from ai.common.utils import optional_bool, require_bool

        with pytest.raises(ValueError, match='must be a boolean'):
            require_bool({'k': 'true'}, 'k')
        with pytest.raises(ValueError, match='must be a boolean'):
            require_bool({'k': '1'}, 'k')
        with pytest.raises(ValueError, match='must be a boolean'):
            optional_bool({'k': 'yes'}, 'k')


# ---------------------------------------------------------------------------
# config_int — bounded int reader
# ---------------------------------------------------------------------------


class TestConfigInt:
    def test_int_value_returned(self):
        assert config_int({'n': 42}, 'n', default=10) == 42

    def test_numeric_string_coerced(self):
        assert config_int({'n': '42'}, 'n', default=10) == 42

    def test_missing_key_returns_default(self):
        assert config_int({}, 'n', default=10) == 10

    def test_none_value_returns_default(self):
        assert config_int({'n': None}, 'n', default=10) == 10

    def test_non_numeric_string_returns_default(self):
        # Garbage in → default out, not a crash.
        assert config_int({'n': 'abc'}, 'n', default=10) == 10

    def test_zero_returns_default(self):
        # 0 is treated as "unspecified" — node-config sliders typically use
        # 0 for "disabled / use default", not as a literal limit.
        assert config_int({'n': 0}, 'n', default=10) == 10

    def test_negative_returns_default(self):
        # Same rationale as zero — non-positive is "unspecified".
        assert config_int({'n': -5}, 'n', default=10) == 10

    def test_list_value_returns_default(self):
        # Unexpected types fall back to default (TypeError on int() path).
        assert config_int({'n': [1, 2]}, 'n', default=10) == 10

    # Bounds -------------------------------------------------------------

    def test_min_value_clamps_below(self):
        # Below min → clamped up. Clamping (not rejecting) means a small
        # misconfig still produces a working node.
        assert config_int({'n': 1}, 'n', default=100, min_value=5) == 5

    def test_min_value_passes_above(self):
        assert config_int({'n': 50}, 'n', default=100, min_value=5) == 50

    def test_max_value_clamps_above(self):
        assert config_int({'n': 999}, 'n', default=100, max_value=200) == 200

    def test_max_value_passes_below(self):
        assert config_int({'n': 50}, 'n', default=100, max_value=200) == 50

    def test_both_bounds_clamp(self):
        assert config_int({'n': 999}, 'n', default=100, min_value=5, max_value=200) == 200
        assert config_int({'n': 1}, 'n', default=100, min_value=5, max_value=200) == 5
        assert config_int({'n': 50}, 'n', default=100, min_value=5, max_value=200) == 50

    def test_default_also_clamped(self):
        # When the value falls back to default, the bounds still apply.
        # An out-of-range default is an author misconfiguration; clamp it
        # rather than letting it through.
        assert config_int({}, 'n', default=1, min_value=5) == 5
        assert config_int({}, 'n', default=999, max_value=200) == 200
