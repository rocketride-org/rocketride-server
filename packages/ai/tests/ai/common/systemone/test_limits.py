# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================
"""Unit tests for ai.common.systemone.limits."""

import pytest

from ai.common.systemone.limits import (
    DecisionLimits,
    estimate_tokens,
    json_bytes,
)


def _limits(**kw):
    base = dict(max_options=26, max_levels=26, max_questions=64, max_state_tokens=100, chars_per_token=4.0)
    base.update(kw)
    return DecisionLimits(**base)


def test_from_config_reads_limits_block():
    cfg = {
        'limits': {
            'max_options': 255,
            'max_levels': 10,
            'max_questions': 64,
            'max_state_tokens': 32000,
            'chars_per_token': 6,
            'max_body_bytes': 65536,
            'object_criteria': False,
        }
    }
    lim = DecisionLimits.from_config(cfg)
    assert lim.max_options == 255 and lim.max_levels == 10
    assert lim.chars_per_token == 6.0 and lim.max_body_bytes == 65536
    assert lim.object_criteria is False


def test_from_config_missing_block_raises():
    with pytest.raises(ValueError, match='limits'):
        DecisionLimits.from_config({})


def test_estimate_tokens_rounds_up():
    assert estimate_tokens('abcde', 4.0) == 2
    assert estimate_tokens('', 4.0) == 0


def test_json_bytes_counts_utf8_non_ascii():
    # Quoted é (2 quote bytes) + 2-byte UTF-8 é = 4 bytes total.
    assert json_bytes('é') == 4


def test_json_bytes_handles_lone_surrogate():
    # Lone surrogates (e.g., from broken PDF text) are replaced with U+FFFD.
    # Should not raise UnicodeEncodeError.
    result = json_bytes('\ud800')
    assert result > 0
