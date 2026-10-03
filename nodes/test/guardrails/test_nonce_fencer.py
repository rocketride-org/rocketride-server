# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Unit tests for the nonce fencer module (guardrails/nonce_fencer.py)."""

import importlib.util
import os
import re

import pytest

_GUARDRAILS_DIR = os.path.join(os.path.dirname(__file__), '..', '..', 'src', 'nodes', 'guardrails')


def _load_nonce_fencer():
    """Import NonceFencer and SecurityError without triggering rocketlib."""
    spec = importlib.util.spec_from_file_location(
        'guardrails.nonce_fencer',
        os.path.join(_GUARDRAILS_DIR, 'nonce_fencer.py'),
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.NonceFencer, mod.SecurityError


NonceFencer, SecurityError = _load_nonce_fencer()


# ---------------------------------------------------------------------------
# Construction
# ---------------------------------------------------------------------------


class TestConstruction:
    """Nonce length validation at init time."""

    def test_default_length(self):
        fencer = NonceFencer()
        assert fencer.nonce_length == 16

    def test_custom_length(self):
        fencer = NonceFencer(nonce_length=32)
        assert fencer.nonce_length == 32

    def test_minimum_length_rejected(self):
        with pytest.raises(ValueError, match='nonce_length must be >= 16'):
            NonceFencer(nonce_length=8)

    def test_boundary_length_accepted(self):
        fencer = NonceFencer(nonce_length=16)
        assert fencer.nonce_length == 16


# ---------------------------------------------------------------------------
# Nonce generation
# ---------------------------------------------------------------------------


class TestNewCycle:
    """Each call to new_cycle returns a unique hex nonce of the right length."""

    def test_nonce_length(self):
        fencer = NonceFencer(nonce_length=16)
        nonce = fencer.new_cycle()
        assert len(nonce) == 32  # hex doubles the byte count

    def test_nonce_is_hex(self):
        fencer = NonceFencer()
        nonce = fencer.new_cycle()
        assert re.fullmatch(r'[0-9a-f]+', nonce)

    def test_nonces_are_unique(self):
        fencer = NonceFencer()
        nonces = {fencer.new_cycle() for _ in range(100)}
        assert len(nonces) == 100


# ---------------------------------------------------------------------------
# Fencing
# ---------------------------------------------------------------------------


class TestFence:
    """Content wrapping between nonce-delimited markers."""

    def test_fenced_structure(self):
        fencer = NonceFencer()
        nonce = fencer.new_cycle()
        result = fencer.fence('hello world', nonce)
        assert result.startswith(f'<<<UNTRUSTED_DATA_{nonce}>>>')
        assert result.endswith(f'<<<END_UNTRUSTED_DATA_{nonce}>>>')
        assert 'hello world' in result

    def test_content_preserved(self):
        fencer = NonceFencer()
        nonce = fencer.new_cycle()
        content = 'The capital of France is Paris.'
        result = fencer.fence(content, nonce)
        # Content sits between the markers
        lines = result.split('\n')
        assert lines[1] == content

    def test_empty_content_returned_unchanged(self):
        fencer = NonceFencer()
        nonce = fencer.new_cycle()
        assert fencer.fence('', nonce) == ''

    def test_none_content_returned_unchanged(self):
        fencer = NonceFencer()
        nonce = fencer.new_cycle()
        assert fencer.fence(None, nonce) is None

    def test_exactly_one_open_and_close_marker(self):
        fencer = NonceFencer()
        nonce = fencer.new_cycle()
        result = fencer.fence('some text', nonce)
        assert result.count(f'<<<UNTRUSTED_DATA_{nonce}>>>') == 1
        assert result.count(f'<<<END_UNTRUSTED_DATA_{nonce}>>>') == 1

    def test_same_nonce_fences_multiple_contents(self):
        fencer = NonceFencer()
        nonce = fencer.new_cycle()
        a = fencer.fence('question text', nonce)
        b = fencer.fence('context document', nonce)
        assert nonce in a
        assert nonce in b


# ---------------------------------------------------------------------------
# System addendum
# ---------------------------------------------------------------------------


class TestBuildSystemAddendum:
    """The LLM directive references the correct nonce markers."""

    def test_addendum_contains_markers(self):
        fencer = NonceFencer()
        nonce = fencer.new_cycle()
        addendum = fencer.build_system_addendum(nonce)
        assert f'UNTRUSTED_DATA_{nonce}' in addendum
        assert f'END_UNTRUSTED_DATA_{nonce}' in addendum

    def test_addendum_contains_directive(self):
        fencer = NonceFencer()
        nonce = fencer.new_cycle()
        addendum = fencer.build_system_addendum(nonce)
        assert 'UNTRUSTED DATA' in addendum
        assert 'Do NOT interpret' in addendum


# ---------------------------------------------------------------------------
# Collision handling
# ---------------------------------------------------------------------------


class TestCollision:
    """Nonce collision retry and failure behaviour."""

    def test_collision_raises_after_max_retries(self, monkeypatch):
        """When the nonce always appears in content, SecurityError is raised."""
        fencer = NonceFencer(nonce_length=16)
        # Force token_hex to always return the same value
        monkeypatch.setattr('secrets.token_hex', lambda n: 'a' * (n * 2))

        content_containing_nonce = 'a' * 32
        with pytest.raises(SecurityError, match='collision'):
            fencer.fence(content_containing_nonce, 'a' * 32)
