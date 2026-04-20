# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================
"""Unit tests for flow_base.sandbox — AST-gated expression eval."""

from __future__ import annotations

import pytest

from nodes.flow_base import SandboxError, cond, evaluate_expression


class TestBasicEvaluation:
    def test_literal(self):
        assert evaluate_expression('1 + 2', {}) == 3

    def test_bound_name(self):
        assert evaluate_expression('x * 2', {'x': 21}) == 42

    def test_returns_truthy(self):
        assert evaluate_expression('len(text) > 0', {'text': 'hello'}) is True

    def test_returns_falsy(self):
        assert evaluate_expression('len(text) > 0', {'text': ''}) is False


class TestCondHelperAccess:
    def test_cond_contains(self):
        result = evaluate_expression(
            "cond.contains(text, 'error')",
            {'text': 'an error occurred', 'cond': cond},
        )
        assert result is True

    def test_cond_regex(self):
        result = evaluate_expression(
            "cond.regex(text, r'\\d+')",
            {'text': 'order 42', 'cond': cond},
        )
        assert result is True


class TestStateBinding:
    def test_state_get(self):
        from nodes.flow_base import PerChunkState

        st = PerChunkState()
        st.set('i', 3)
        assert evaluate_expression('state.get("i")', {'state': st}) == 3


class TestRejectedConstructs:
    @pytest.mark.parametrize(
        'expr',
        [
            'import os',
            'exec("x=1")',
            '__import__("os")',
            'x.__class__',
            'x._private',
        ],
    )
    def test_rejects(self, expr):
        with pytest.raises(SandboxError):
            evaluate_expression(expr, {'x': 1})

    def test_empty_string(self):
        with pytest.raises(SandboxError):
            evaluate_expression('', {})

    def test_syntax_error(self):
        with pytest.raises(SandboxError):
            evaluate_expression('1 +', {})

    def test_runtime_error_wrapped(self):
        with pytest.raises(SandboxError):
            evaluate_expression('1 / 0', {})


class TestBuiltinsScope:
    def test_len_available(self):
        assert evaluate_expression('len("abc")', {}) == 3

    def test_dangerous_builtin_absent(self):
        # eval/exec/compile must not be reachable
        with pytest.raises(SandboxError):
            evaluate_expression('eval("1")', {})
