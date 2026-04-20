# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================
"""Unit tests for flow_base.state.PerChunkState."""

from __future__ import annotations

from nodes.flow_base import PerChunkState


class TestBasicOps:
    def test_get_missing_returns_default(self):
        s = PerChunkState()
        assert s.get('missing') is None
        assert s.get('missing', 42) == 42

    def test_set_and_get(self):
        s = PerChunkState()
        s.set('counter', 1)
        assert s.get('counter') == 1

    def test_setdefault_inserts_only_if_missing(self):
        s = PerChunkState()
        assert s.setdefault('k', 'first') == 'first'
        assert s.setdefault('k', 'second') == 'first'
        assert s.get('k') == 'first'

    def test_update_merges(self):
        s = PerChunkState()
        s.update({'a': 1, 'b': 2})
        assert s.get('a') == 1
        assert s.get('b') == 2

    def test_pop_removes(self):
        s = PerChunkState()
        s.set('x', 10)
        assert s.pop('x') == 10
        assert 'x' not in s

    def test_clear_empties(self):
        s = PerChunkState()
        s.set('a', 1)
        s.set('b', 2)
        s.clear()
        assert len(s) == 0


class TestScopeIsolation:
    """Two states are independent — foundational invariant for async safety."""

    def test_two_instances_do_not_share(self):
        s1 = PerChunkState()
        s2 = PerChunkState()
        s1.set('shared_key', 'from_s1')
        assert s2.get('shared_key') is None
