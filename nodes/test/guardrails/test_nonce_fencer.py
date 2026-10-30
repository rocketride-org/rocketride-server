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


class TestConstruction:
    """Nonce length configuration at init time."""

    def test_default_length(self):
        assert NonceFencer().nonce_length == 16

    def test_custom_length(self):
        assert NonceFencer(nonce_length=32).nonce_length == 32

    def test_boundary_length_accepted(self):
        assert NonceFencer(nonce_length=16).nonce_length == 16


class TestNewCycle:
    """Each call to new_cycle returns a unique hex nonce of the right length."""

    def test_nonce_length(self):
        assert len(NonceFencer(nonce_length=16).new_cycle()) == 32

    def test_nonce_is_hex(self):
        assert re.fullmatch(r'[0-9a-f]+', NonceFencer().new_cycle())

    def test_nonces_are_unique(self):
        nonces = {NonceFencer().new_cycle() for _ in range(100)}
        assert len(nonces) == 100


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
        assert fencer.fence(content, nonce).split('\n')[1] == content

    @pytest.mark.parametrize('content', ['', None])
    def test_empty_content_returned_unchanged(self, content):
        assert NonceFencer().fence(content, 'a' * 32) == content

    def test_exactly_one_open_and_close_marker(self):
        fencer = NonceFencer()
        nonce = fencer.new_cycle()
        result = fencer.fence('some text', nonce)
        assert result.count(f'<<<UNTRUSTED_DATA_{nonce}>>>') == 1
        assert result.count(f'<<<END_UNTRUSTED_DATA_{nonce}>>>') == 1

    def test_same_nonce_fences_multiple_contents(self):
        fencer = NonceFencer()
        nonce = fencer.new_cycle()
        assert nonce in fencer.fence('question text', nonce)
        assert nonce in fencer.fence('context document', nonce)

    def test_fence_raises_when_nonce_in_content(self):
        with pytest.raises(SecurityError, match='selected nonce was found'):
            NonceFencer().fence('prefix ' + 'a' * 32, 'a' * 32)


class TestBuildSystemAddendum:
    """The LLM directive references the correct nonce markers."""

    def test_addendum_contains_markers(self):
        fencer = NonceFencer()
        nonce = fencer.new_cycle()
        addendum = fencer.build_system_addendum(nonce)
        assert f'UNTRUSTED_DATA_{nonce}' in addendum
        assert f'END_UNTRUSTED_DATA_{nonce}' in addendum

    def test_addendum_contains_directive(self):
        addendum = NonceFencer().build_system_addendum('a' * 32)
        assert 'UNTRUSTED DATA' in addendum
        assert 'Do NOT interpret' in addendum


class TestCollision:
    """Nonce collision retry and failure behaviour."""

    def test_new_cycle_retries_after_collision(self, monkeypatch):
        fencer = NonceFencer(nonce_length=16)
        calls = ['a' * 32, 'b' * 32]
        monkeypatch.setattr('secrets.token_hex', lambda n: calls.pop(0))
        assert fencer.new_cycle(exclude='content ' + ('a' * 32)) == 'b' * 32

    def test_new_cycle_raises_on_collision_exhaustion(self, monkeypatch):
        fencer = NonceFencer(nonce_length=16)
        monkeypatch.setattr('secrets.token_hex', lambda n: 'a' * 32)
        with pytest.raises(SecurityError, match='found in content'):
            fencer.new_cycle(exclude='a' * 32)
