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
"""Unit tests for ai.common.decision.limits."""

import pytest

from ai.common.decision.limits import (
    DecisionLimits,
    estimate_tokens,
    fit_content,
    json_bytes,
    shrink,
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


def test_fit_content_under_budget_untouched():
    text, truncated = fit_content('x' * 100, _limits(), reserved_tokens=10, reserved_bytes=0)
    assert text == 'x' * 100 and truncated is False


def test_fit_content_cuts_tail_keeps_head():
    text = 'HEAD' + 'y' * 1000
    out, truncated = fit_content(text, _limits(), reserved_tokens=50, reserved_bytes=0)
    assert truncated is True
    assert out.startswith('HEAD')
    assert len(out) == (100 - 50) * 4


def test_fit_content_reserved_exceeds_budget_returns_empty():
    out, truncated = fit_content('abc', _limits(), reserved_tokens=500, reserved_bytes=0)
    assert out == '' and truncated is True


def test_fit_content_respects_utf8_json_byte_budget():
    # Each emoji is 4 UTF-8 bytes but json.dumps escapes it to 12 ASCII bytes (surrogate pair).
    text = '\U0001f600' * 1000
    lim = _limits(max_state_tokens=10_000_000, max_body_bytes=2000)
    out, truncated = fit_content(text, lim, reserved_tokens=0, reserved_bytes=500)
    assert truncated is True
    assert json_bytes(out) <= 1500


def test_shrink_keeps_three_quarters():
    assert shrink('a' * 100) == 'a' * 75
