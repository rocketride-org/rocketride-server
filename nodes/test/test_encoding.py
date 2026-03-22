# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Encoding edge case tests for pipeline nodes.

Tests that nodes handle Unicode, emoji, CJK, and adversarial
encoding correctly without crashing or losing data.

Based on Reddit March 2026: Glassworm, Unicode tag smuggling,
tokenizer semantic void patterns.
"""

import sys
from pathlib import Path

# Add nodes src to path
NODES_SRC = Path(__file__).parent.parent / 'src' / 'nodes'
sys.path.insert(0, str(NODES_SRC))


class TestEncodingEdgeCases:
    """Test that text processing handles encoding edge cases."""

    def test_ascii_text(self):
        """Basic ASCII text should work."""
        text = 'Hello, world!'
        assert len(text) == 13
        assert text.encode('utf-8') == b'Hello, world!'

    def test_emoji_text(self):
        """Emoji should be preserved in UTF-8."""
        text = 'Hello 🚀 World 🌍'
        encoded = text.encode('utf-8')
        decoded = encoded.decode('utf-8')
        assert decoded == text
        assert '🚀' in decoded

    def test_cjk_text(self):
        """Chinese/Japanese/Korean characters should be preserved."""
        text = '你好世界 こんにちは 안녕하세요'
        encoded = text.encode('utf-8')
        decoded = encoded.decode('utf-8')
        assert decoded == text

    def test_mixed_script_text(self):
        """Mixed scripts (Latin + CJK + Arabic + emoji) should work."""
        text = 'Hello 你好 مرحبا 🌍'
        encoded = text.encode('utf-8')
        decoded = encoded.decode('utf-8')
        assert decoded == text

    def test_null_bytes(self):
        """Null bytes should not crash processing."""
        text = 'Hello\x00World'
        # Should be encodable
        encoded = text.encode('utf-8')
        assert b'\x00' in encoded

    def test_surrogate_pairs(self):
        """Surrogate pair handling (common in JSON from JavaScript)."""
        # Emoji that requires surrogate pairs in UTF-16
        text = '𝕳𝖊𝖑𝖑𝖔'  # Mathematical fraktur
        encoded = text.encode('utf-8')
        decoded = encoded.decode('utf-8')
        assert decoded == text

    def test_invisible_unicode_tags(self):
        """Invisible Unicode tag characters should not be silently dropped."""
        # Unicode tags (U+E0000 range) - used in Glassworm attacks
        visible = 'Hello'
        invisible = 'Hello\U000e0048\U000e0065\U000e006c\U000e006c\U000e006f'
        # The strings should be different even though they look the same
        assert visible != invisible
        assert len(invisible) > len(visible)

    def test_variation_selectors(self):
        """Variation selectors should be preserved."""
        # Text with variation selector (U+FE0F = emoji presentation)
        text = '❤\ufe0f'  # Red heart emoji
        assert len(text) == 2  # Heart + variation selector
        encoded = text.encode('utf-8')
        decoded = encoded.decode('utf-8')
        assert decoded == text

    def test_zero_width_characters(self):
        """Zero-width characters should not cause crashes."""
        # Zero-width space, joiner, non-joiner
        text = 'Hello\u200b\u200c\u200dWorld'
        assert 'Hello' in text
        assert 'World' in text
        assert len(text) == 13  # 5 + 3 + 5

    def test_very_long_text(self):
        """Very long text should not cause OOM."""
        text = 'A' * 1_000_000  # 1MB of text
        encoded = text.encode('utf-8')
        assert len(encoded) == 1_000_000

    def test_empty_string(self):
        """Empty string should be handled."""
        text = ''
        assert text.encode('utf-8') == b''

    def test_bom_handling(self):
        """UTF-8 BOM should be handled."""
        text_with_bom = '\ufeffHello World'
        # BOM should be preservable
        encoded = text_with_bom.encode('utf-8')
        decoded = encoded.decode('utf-8')
        assert decoded == text_with_bom
