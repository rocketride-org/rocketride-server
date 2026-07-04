# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Unit tests for ``ai.common.utils.safe_str``.

This is the shared `safe_str` used by every node-side agent driver
(`agent_langchain`, `agent_deepagent`, `agent_crewai`, `agent_rocketride`).
The `ai` package keeps a separate, internal `safe_str` in
``ai.common.agent._internal.utils`` for agent runtime use; the two are
unrelated.

Run with::

    pytest packages/ai/tests/ai/common/utils/test_utils.py -v
"""

from __future__ import annotations

from ai.common.utils import safe_str


class TestSafeStr:
    def test_none_returns_empty_string(self):
        assert safe_str(None) == ''

    def test_string_returned_unchanged(self):
        assert safe_str('hello') == 'hello'

    def test_empty_string_unchanged(self):
        assert safe_str('') == ''

    def test_int_stringified(self):
        assert safe_str(42) == '42'

    def test_float_stringified(self):
        assert safe_str(3.14) == '3.14'

    def test_bool_stringified(self):
        assert safe_str(True) == 'True'
        assert safe_str(False) == 'False'

    def test_list_stringified(self):
        assert safe_str([1, 2, 3]) == '[1, 2, 3]'

    def test_dict_stringified(self):
        # dict str() is insertion-ordered as of Python 3.7+.
        assert safe_str({'a': 1}) == "{'a': 1}"

    def test_object_with_custom_str(self):
        class _Custom:
            def __str__(self):
                return 'custom-repr'

        assert safe_str(_Custom()) == 'custom-repr'

    def test_object_whose_str_raises_returns_empty(self):
        # Defensive contract: a malformed __str__ must not propagate. This is
        # the whole reason this helper exists — agent transcript code calls
        # it on arbitrary LLM-driven objects.
        class _Broken:
            def __str__(self):
                raise RuntimeError('boom')

        assert safe_str(_Broken()) == ''

    def test_object_whose_str_raises_arbitrary_exception(self):
        # Any exception type, not just RuntimeError, must be caught.
        class _Broken:
            def __str__(self):
                raise ValueError('also boom')

        assert safe_str(_Broken()) == ''
