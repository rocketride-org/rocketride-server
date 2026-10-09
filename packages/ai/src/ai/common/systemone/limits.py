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
"""Per-backend limits for System One decision models, and input truncation."""

from __future__ import annotations

import json
import math
from dataclasses import dataclass

QUESTION_CHARS_PER_TOKEN = 4.0
REQUEST_OVERHEAD_TOKENS = 260


@dataclass(frozen=True)
class DecisionLimits:
    """Limits one backend enforces; they belong to the model, not the client."""

    max_options: int
    max_levels: int
    max_questions: int
    max_state_tokens: int
    chars_per_token: float = 6.0
    max_body_bytes: int | None = None
    object_criteria: bool = True

    @classmethod
    def from_config(cls, config: dict) -> DecisionLimits:
        """Build limits from the ``limits`` block of a merged node config."""
        block = config.get('limits')
        if not isinstance(block, dict):
            raise ValueError('decision node config has no "limits" block')
        return cls(
            max_options=int(block['max_options']),
            max_levels=int(block['max_levels']),
            max_questions=int(block['max_questions']),
            max_state_tokens=int(block['max_state_tokens']),
            chars_per_token=float(block.get('chars_per_token', 6.0)),
            max_body_bytes=int(block['max_body_bytes']) if block.get('max_body_bytes') else None,
            object_criteria=bool(block.get('object_criteria', True)),
        )


def estimate_tokens(text: str, chars_per_token: float) -> int:
    """Estimate tokens for ``text`` with a characters-per-token heuristic."""
    return math.ceil(len(text) / chars_per_token) if text else 0


def encode_json(value) -> bytes:
    """Return ``value`` as the UTF-8 bytes that will be sent in a request body.

    Uses compact encoding (no spaces, UTF-8 non-ASCII characters).
    Lone surrogates, which UTF-8 cannot encode, are replaced with ``?``.
    """
    return json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode('utf-8', errors='replace')


def json_bytes(value) -> int:
    """Return the number of bytes ``value`` occupies once JSON-encoded."""
    return len(encode_json(value))


def fit_content(content: str, limits: DecisionLimits, reserved_tokens: int, reserved_bytes: int) -> tuple[str, bool]:
    """Cut ``content`` from the end so the request fits the backend's limits.

    Args:
        content: The document text that goes into the state.
        limits: The backend's limits.
        reserved_tokens: Tokens already spent by overhead, the longest question and other state parts.
        reserved_bytes: Bytes of the request body excluding ``content``.

    Returns:
        ``(kept_content, truncated)``. The head of the text is always the part kept.
    """
    kept = content
    token_budget = limits.max_state_tokens - reserved_tokens
    max_chars = max(0, int(token_budget * limits.chars_per_token))
    if len(kept) > max_chars:
        kept = kept[:max_chars]
    if limits.max_body_bytes is not None:
        byte_budget = max(0, limits.max_body_bytes - reserved_bytes)
        while kept and json_bytes(kept) > byte_budget:
            overshoot = json_bytes(kept) - byte_budget
            kept = kept[: max(0, len(kept) - max(1, overshoot // 12))]
    return kept, kept != content


def shrink(content: str, factor: float = 0.75) -> str:
    """Return the head ``factor`` of ``content`` (used for the one too-large retry)."""
    return content[: int(len(content) * factor)]
