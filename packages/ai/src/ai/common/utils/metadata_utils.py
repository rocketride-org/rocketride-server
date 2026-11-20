# =============================================================================
# MIT License
#
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

"""
Pipeline metadata helpers.

This is the single home of ``merge_metadata``. Dataset/evaluator nodes and the
LLM drivers all carry non-prompt state on ``Question.metadata`` /
``Answer.metadata``; they merge it through here rather than each repeating the
update-or-assign dance.
"""

from typing import Any, Dict, Optional

__all__ = ['merge_metadata']


def merge_metadata(target: Any, metadata: Optional[Dict[str, Any]]) -> None:
    """Merge pipeline metadata into ``target.metadata``.

    Updates the target's existing dict in place when it has one, so keys set by
    an earlier node survive; otherwise assigns a shallow copy. The copy matters
    for fan-out — sharing the source dict would let one branch's writes appear
    in another's.

    Args:
        target: Object carrying a ``metadata`` attribute, typically a
            ``Question`` or an ``Answer``.
        metadata: Mapping to merge in. A ``None``, empty, or non-dict value is
            ignored.

    Returns:
        None. ``target`` is modified in place.
    """
    if not isinstance(metadata, dict) or not metadata:
        return

    existing = getattr(target, 'metadata', None)
    if isinstance(existing, dict):
        existing.update(metadata)
    else:
        target.metadata = dict(metadata)
