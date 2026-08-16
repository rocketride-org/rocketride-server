# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Property tests for the Nonce Fencer (Properties 6-8)."""

import pytest
from hypothesis import given, settings, assume
from hypothesis import strategies as st

from input_prescreen.nonce_fencer import NonceFencer, SecurityError


# ---------------------------------------------------------------------------
# Property 6: Nonce Fence Unambiguity
# Validates: Requirements 3.2
# ---------------------------------------------------------------------------

class TestNonceFenceUnambiguity:
    """For any nonce and content where nonce not in content, fence() produces
    exactly one open and one close marker."""

    @given(content=st.text(min_size=1, max_size=500))
    @settings(max_examples=200)
    def test_fence_has_exactly_one_open_and_close(self, content):
        """Fenced output contains exactly one opening and one closing marker."""
        fencer = NonceFencer(nonce_length=16)
        nonce = fencer.new_cycle()

        # Skip if nonce happens to be in content (extremely unlikely with 32 hex chars)
        assume(nonce not in content)

        fenced = fencer.fence(content, nonce)

        open_marker = f"<<<UNTRUSTED_DATA_{nonce}>>>"
        close_marker = f"<<<END_UNTRUSTED_DATA_{nonce}>>>"

        assert fenced.count(open_marker) == 1
        assert fenced.count(close_marker) == 1

    @given(content=st.text(min_size=1, max_size=200))
    @settings(max_examples=100)
    def test_original_content_preserved_inside_fence(self, content):
        """The original content appears between the markers."""
        fencer = NonceFencer(nonce_length=16)
        nonce = fencer.new_cycle()
        assume(nonce not in content)

        fenced = fencer.fence(content, nonce)
        assert content in fenced

    def test_empty_content_returns_unchanged(self):
        """Empty string returns empty, None returns None."""
        fencer = NonceFencer(nonce_length=16)
        nonce = fencer.new_cycle()

        assert fencer.fence('', nonce) == ''
        assert fencer.fence(None, nonce) is None


# ---------------------------------------------------------------------------
# Property 7: Nonce Collision Resolution
# Validates: Requirements 3.3
# ---------------------------------------------------------------------------

class TestNonceCollisionResolution:
    """After fence() completes, the nonce in markers does not appear in original content."""

    @given(content=st.text(min_size=1, max_size=200))
    @settings(max_examples=200)
    def test_no_collision_in_output(self, content):
        """The nonce used in the output does not collide with original content."""
        fencer = NonceFencer(nonce_length=16)
        nonce = fencer.new_cycle()

        try:
            fenced = fencer.fence(content, nonce)
        except SecurityError:
            # Only happens after 10 retries — acceptable edge case
            return

        if not fenced:
            return

        # Extract the nonce from the opening marker
        import re
        match = re.search(r'<<<UNTRUSTED_DATA_([a-f0-9]+)>>>', fenced)
        assert match is not None
        used_nonce = match.group(1)

        # The used nonce must NOT appear in the original content
        assert used_nonce not in content

    def test_collision_triggers_regeneration(self):
        """When nonce is in content, fencer regenerates."""
        fencer = NonceFencer(nonce_length=16)
        nonce = fencer.new_cycle()

        # Content containing the nonce
        content = f"some text with {nonce} embedded"
        fenced = fencer.fence(content, nonce)

        # The fence should succeed (regenerated nonce)
        assert "<<<UNTRUSTED_DATA_" in fenced
        assert content in fenced


# ---------------------------------------------------------------------------
# Property 8: Nonce Format Invariant
# Validates: Requirements 3.1, 3.6
# ---------------------------------------------------------------------------

class TestNonceFormatInvariant:
    """Nonces are hex strings of exactly nonce_length * 2 characters."""

    @given(nonce_length=st.integers(min_value=16, max_value=64))
    @settings(max_examples=50)
    def test_nonce_length_correct(self, nonce_length):
        """new_cycle() returns hex string of length nonce_length * 2."""
        fencer = NonceFencer(nonce_length=nonce_length)
        nonce = fencer.new_cycle()

        assert len(nonce) == nonce_length * 2
        # Verify it's valid hex
        assert all(c in '0123456789abcdef' for c in nonce)

    def test_consecutive_nonces_distinct(self):
        """Consecutive calls return distinct nonces."""
        fencer = NonceFencer(nonce_length=16)
        nonces = {fencer.new_cycle() for _ in range(100)}
        assert len(nonces) == 100

    def test_min_length_validation(self):
        """nonce_length < 16 raises ValueError."""
        with pytest.raises(ValueError):
            NonceFencer(nonce_length=8)

        with pytest.raises(ValueError):
            NonceFencer(nonce_length=0)
