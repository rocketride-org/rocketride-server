"""
Unit tests for ai.common.chat._normalize_usage.

Locks the contract between LangChain ``AIMessage.usage_metadata`` and the
shape attached to ``Answer.usage_metadata``, which rides the writeAnswers
trace into ``apaevt_flow op:leave`` events.

Run from project root:
  PYTHONPATH=packages/ai/src python -m pytest packages/ai/tests/ai/common/test_chat_usage.py -v
"""

import sys
from unittest.mock import MagicMock

sys.modules.setdefault('depends', MagicMock())
sys.modules.setdefault('engLib', MagicMock())

import pytest  # noqa: E402

from ai.common.chat import _accumulate_usage, _normalize_usage  # noqa: E402


@pytest.mark.parametrize('value', [None, 0, 'string', [], (1, 2), 3.14])
def test_returns_none_for_non_dict_input(value):
    """Non-dict inputs (incl. ``None``) collapse to ``None`` so ``chat()`` skips the field."""
    assert _normalize_usage(value) is None


def test_returns_none_for_empty_dict():
    """Empty dict has no extractable fields, so result is ``None`` (not an empty dict)."""
    assert _normalize_usage({}) is None


def test_returns_none_when_no_recognised_fields():
    """Dict with only unrelated keys yields ``None`` rather than a partial dict."""
    assert _normalize_usage({'foo': 1, 'bar': 'baz'}) is None


def test_anthropic_full_shape_populates_flat_cache_aliases():
    """Anthropic's nested ``input_token_details`` is mirrored as flat ``cache_*_input_tokens`` aliases."""
    usage = {
        'input_tokens': 100,
        'output_tokens': 50,
        'total_tokens': 150,
        'input_token_details': {
            'cache_read': 80,
            'cache_creation': 10,
        },
    }
    result = _normalize_usage(usage)
    assert result == {
        'input_tokens': 100,
        'output_tokens': 50,
        'total_tokens': 150,
        'input_token_details': {'cache_read': 80, 'cache_creation': 10},
        'cache_read_input_tokens': 80,
        'cache_creation_input_tokens': 10,
    }


def test_openai_shape_has_no_cache_aliases():
    """LangChain's OpenAI/Bedrock shape lacks cache details, so no flat aliases are added."""
    usage = {'input_tokens': 25, 'output_tokens': 12, 'total_tokens': 37}
    result = _normalize_usage(usage)
    assert result == {'input_tokens': 25, 'output_tokens': 12, 'total_tokens': 37}
    assert 'cache_read_input_tokens' not in result
    assert 'cache_creation_input_tokens' not in result


def test_partial_cache_details_only_adds_present_aliases():
    """Only the cache-detail keys that are present get flat aliases (one-sided is allowed)."""
    usage = {
        'input_tokens': 10,
        'output_tokens': 5,
        'input_token_details': {'cache_read': 7},
    }
    result = _normalize_usage(usage)
    assert result['cache_read_input_tokens'] == 7
    assert 'cache_creation_input_tokens' not in result


def test_output_token_details_preserved():
    """``output_token_details`` is preserved alongside ``input_token_details``."""
    usage = {
        'input_tokens': 10,
        'output_tokens': 20,
        'output_token_details': {'reasoning': 8},
    }
    result = _normalize_usage(usage)
    assert result['output_token_details'] == {'reasoning': 8}


def test_floats_are_rounded_to_int():
    """Float counts (e.g. from JSON round-trips) are rounded to the nearest int, not truncated."""
    usage = {
        'input_tokens': 12.9,
        'output_tokens': 4.0,
        'input_token_details': {'cache_read': 3.7},
    }
    result = _normalize_usage(usage)
    assert result['input_tokens'] == 13
    assert result['output_tokens'] == 4
    assert result['input_token_details']['cache_read'] == 4
    assert result['cache_read_input_tokens'] == 4


def test_malformed_details_dropped_silently():
    """Non-dict ``input_token_details`` is ignored without raising; top-level fields still flow."""
    usage = {
        'input_tokens': 10,
        'output_tokens': 5,
        'input_token_details': 'not-a-dict',
    }
    result = _normalize_usage(usage)
    assert result == {'input_tokens': 10, 'output_tokens': 5}


def test_non_numeric_field_values_skipped():
    """Non-numeric counts (str, None) are skipped rather than coerced."""
    usage = {
        'input_tokens': 'twelve',
        'output_tokens': None,
        'total_tokens': 0,
    }
    result = _normalize_usage(usage)
    assert result == {'total_tokens': 0}


# -----------------------------------------------------------------------------
# _accumulate_usage — sum-across-retries contract
# -----------------------------------------------------------------------------


def test_accumulate_no_op_on_empty_or_none():
    """``None`` and empty-dict latest values leave target untouched."""
    target: dict = {}
    _accumulate_usage(target, None)
    _accumulate_usage(target, {})
    assert target == {}


def test_accumulate_sums_top_level_ints():
    """Sequential calls sum top-level int fields rather than overwriting."""
    target: dict = {}
    _accumulate_usage(target, {'input_tokens': 1000, 'output_tokens': 500, 'total_tokens': 1500})
    _accumulate_usage(target, {'input_tokens': 1050, 'output_tokens': 600, 'total_tokens': 1650})
    _accumulate_usage(target, {'input_tokens': 1050, 'output_tokens': 450, 'total_tokens': 1500})
    assert target == {'input_tokens': 3100, 'output_tokens': 1550, 'total_tokens': 4650}


def test_accumulate_sums_nested_details():
    """Nested ``input_token_details`` / ``output_token_details`` keys sum element-wise."""
    target: dict = {}
    _accumulate_usage(target, {'input_token_details': {'cache_read': 80, 'cache_creation': 10}})
    _accumulate_usage(target, {'input_token_details': {'cache_read': 90, 'cache_creation': 0}})
    assert target == {'input_token_details': {'cache_read': 170, 'cache_creation': 10}}


def test_accumulate_sums_flat_cache_aliases():
    """Flat ``cache_*_input_tokens`` aliases (added by _normalize_usage) accumulate too."""
    target: dict = {}
    _accumulate_usage(target, {'cache_read_input_tokens': 80, 'cache_creation_input_tokens': 10})
    _accumulate_usage(target, {'cache_read_input_tokens': 90})
    assert target == {'cache_read_input_tokens': 170, 'cache_creation_input_tokens': 10}


def test_accumulate_preserves_keys_only_in_one_attempt():
    """Keys present in only one attempt still land in the accumulated result."""
    target: dict = {}
    _accumulate_usage(target, {'input_tokens': 10})
    _accumulate_usage(target, {'output_tokens': 5})
    assert target == {'input_tokens': 10, 'output_tokens': 5}


def test_accumulate_end_to_end_with_normalize():
    """Realistic retry sequence: each attempt's raw usage flows through normalize then accumulate."""
    target: dict = {}
    for raw in (
        {'input_tokens': 1000, 'output_tokens': 500, 'input_token_details': {'cache_read': 200}},
        {'input_tokens': 1050, 'output_tokens': 600, 'input_token_details': {'cache_read': 1000}},
        {'input_tokens': 1050, 'output_tokens': 450, 'input_token_details': {'cache_read': 1000}},
    ):
        _accumulate_usage(target, _normalize_usage(raw))
    assert target['input_tokens'] == 3100
    assert target['output_tokens'] == 1550
    assert target['cache_read_input_tokens'] == 2200
    assert target['input_token_details']['cache_read'] == 2200
