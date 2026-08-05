# =============================================================================
# MIT License
# Copyright (c) 2024 RocketRide Inc.
# =============================================================================

"""Regression tests for _resolve_path_params (issue #1369).

Path-param values are percent-encoded and inserted via a re.sub callback. This
keeps each value as a single, literal path segment: a value used as a plain
re.sub replacement string would be interpreted as a template (``\\1`` ->
``re.error``, ``\\t`` -> a tab character), and an unencoded value could contain
``/`` or ``..`` and alter the URL structure past the allowlist.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

# requests is imported at module import time by http_client; skip cleanly if
# it is not installed in this environment.
pytest.importorskip('requests')

# Add the node source directory to sys.path so we can import the module
# without triggering the top-level nodes/__init__.py (which requires the
# engine runtime). Mirrors test_rate_limiter.py.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent / 'src' / 'nodes' / 'tool_http_request'))

from http_client import _resolve_path_params  # noqa: E402


def test_group_reference_value_is_literal():
    """A value of '\\1' must not be treated as a backref; the backslash is encoded."""
    out = _resolve_path_params('https://api/x/:id', {'id': r'\1'})
    assert out == 'https://api/x/%5C1'


def test_backslash_escape_value_is_literal():
    """'\\t' and '\\n' must stay literal (backslash encoded), not become control chars."""
    out_tab = _resolve_path_params('https://api/x/:id', {'id': r'a\tb'})
    assert out_tab == 'https://api/x/a%5Ctb'
    assert '\t' not in out_tab

    out_newline = _resolve_path_params('https://api/x/:id', {'id': r'a\nb'})
    assert out_newline == 'https://api/x/a%5Cnb'
    assert '\n' not in out_newline


def test_reserved_chars_are_encoded_to_stay_one_segment():
    """A value with '/', '..' or '?' is encoded so it cannot escape its path segment."""
    out = _resolve_path_params('https://api/public/:id', {'id': '../admin?x=1'})
    assert out == 'https://api/public/..%2Fadmin%3Fx%3D1'
    assert '/admin' not in out


def test_plain_value_substitution():
    """Ordinary values replace every matching ':name' placeholder."""
    out = _resolve_path_params('https://api/users/:id/posts/:postId', {'id': '42', 'postId': '7'})
    assert out == 'https://api/users/42/posts/7'


def test_non_string_value_is_stringified():
    """Non-string values are coerced via str() before substitution."""
    out = _resolve_path_params('https://api/x/:id', {'id': 123})
    assert out == 'https://api/x/123'


def test_no_params_returns_url_unchanged():
    """An empty or None mapping leaves the URL untouched."""
    assert _resolve_path_params('https://api/x/:id', None) == 'https://api/x/:id'
    assert _resolve_path_params('https://api/x/:id', {}) == 'https://api/x/:id'


def test_word_boundary_prevents_partial_key_match():
    """':id' must not match the ':identifier' placeholder prefix."""
    out = _resolve_path_params('https://api/:identifier', {'id': 'X'})
    assert out == 'https://api/:identifier'
