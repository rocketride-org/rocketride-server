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
# The above copyright notice and this permission notice shall be included in all
# copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.

"""
Run-log segment codec — the Python reference implementation (DVR v2).

Segments are self-contained containers (video-codec model): each opens with a
``{"type": "keyframe"}`` preamble line carrying accumulated state, and interior
events may carry DELTA bodies whose base is guaranteed to live in the SAME
segment:

- status deltas reference the previous status (or the keyframe's base);
- trace LEAVE deltas reference their paired ENTER (most-recent open frame of
  the same pipe id + component) — leaves whose enter landed in an earlier
  segment are stored full.

This ONE module serves three consumers: the server's RunLogWriter/Reader
(``ai`` depends on this package) and the Python SDK's event-stream session.
The TypeScript SDK mirrors it 1:1.
"""

from typing import Any, Dict, List, Optional

# Delta body marker: {'__delta__': {<changed keys>}}; dict values diff one
# level deep; removed keys are listed under '__deleted__'.
DELTA_KEY = '__delta__'
DELETED_KEY = '__deleted__'


def shallow_delta(prev: Any, curr: Any) -> Any:
    """
    One-level-deep diff of two dicts: changed keys only.

    Dict-valued fields are diffed one level (their changed sub-keys only);
    everything else is compared whole. Keys present in ``prev`` but absent in
    ``curr`` are recorded under ``DELETED_KEY``.

    Args:
        prev: The base object (as previously written to the segment).
        curr: The new object.

    Returns:
        The changes dict (possibly empty), or ``curr`` unchanged when either
        side is not a dict.
    """
    if not isinstance(prev, dict) or not isinstance(curr, dict):
        return curr
    changes: Dict[str, Any] = {}
    for key, value in curr.items():
        old = prev.get(key, DELETED_KEY)
        if isinstance(value, dict) and isinstance(old, dict):
            sub = {k: v for k, v in value.items() if old.get(k, DELETED_KEY) != v}
            sub_deleted = [k for k in old if k not in value]
            if sub or sub_deleted:
                if sub_deleted:
                    sub[DELETED_KEY] = sub_deleted
                changes[key] = sub
        elif old != value:
            changes[key] = value
    deleted = [key for key in prev if key not in curr]
    if deleted:
        changes[DELETED_KEY] = deleted
    return changes


def apply_shallow_delta(base: Any, changes: Any) -> Any:
    """
    Inverse of :func:`shallow_delta` — reconstruct the full object.

    Args:
        base: The base object the delta was computed against.
        changes: The changes dict from the delta body.

    Returns:
        The reconstructed full object (base is not mutated).
    """
    if not isinstance(base, dict) or not isinstance(changes, dict):
        return changes
    result = dict(base)
    for key in changes.get(DELETED_KEY, []):
        result.pop(key, None)
    for key, value in changes.items():
        if key == DELETED_KEY:
            continue
        old = result.get(key)
        if isinstance(value, dict) and isinstance(old, dict):
            merged = dict(old)
            for sub_key in value.get(DELETED_KEY, []):
                merged.pop(sub_key, None)
            for sub_key, sub_value in value.items():
                if sub_key != DELETED_KEY:
                    merged[sub_key] = sub_value
            result[key] = merged
        else:
            result[key] = value
    return result


class SegmentDecoder:
    """
    Stateful per-segment decoder: resolves delta bodies back to full events.

    Feed it every line of ONE segment in order (keyframe first). Matching
    identity for leave deltas mirrors the writer: most-recent open frame of
    the same (pipe id, component).
    """

    def __init__(self) -> None:
        """Start with no base state (a keyframe or first full status seeds it)."""
        self._prev_status: Optional[Dict[str, Any]] = None
        # Per pipe id: stack of (component, enter trace.data as written).
        self._open: Dict[Any, List[tuple]] = {}

    def seed(self, keyframe: Dict[str, Any]) -> None:
        """Seed decoder state from a segment's keyframe preamble."""
        status = keyframe.get('status')
        self._prev_status = status if isinstance(status, dict) and status else None

    def decode(self, msg: Dict[str, Any]) -> Dict[str, Any]:
        """
        Resolve one event's delta body (if any) and update decoder state.

        Args:
            msg: A parsed event line (NOT a keyframe line).

        Returns:
            The event with a fully reconstructed body.
        """
        event = msg.get('event')
        body = msg.get('body')

        if event == 'apaevt_status_update' and isinstance(body, dict):
            if DELTA_KEY in body:
                full = apply_shallow_delta(self._prev_status or {}, body[DELTA_KEY])
                msg = dict(msg)
                msg['body'] = full
                self._prev_status = full
            else:
                self._prev_status = body
            return msg

        if event == 'apaevt_flow' and isinstance(body, dict):
            op = body.get('op')
            pid = body.get('id')
            component = body.get('component')
            trace = body.get('trace') or {}
            data = trace.get('data')

            if op == 'begin':
                self._open.setdefault(pid, [])
                return msg
            if op == 'end':
                self._open.pop(pid, None)
                return msg
            if op == 'enter':
                self._open.setdefault(pid, []).append((component, data))
                return msg
            if op == 'leave':
                stack = self._open.get(pid) or []
                match_idx = next((i for i in range(len(stack) - 1, -1, -1) if stack[i][0] == component), None)
                base = stack.pop(match_idx)[1] if match_idx is not None else None
                if isinstance(data, dict) and DELTA_KEY in data:
                    full_data = apply_shallow_delta(base if isinstance(base, dict) else {}, data[DELTA_KEY])
                    msg = dict(msg)
                    new_trace = dict(trace)
                    new_trace['data'] = full_data
                    new_body = dict(body)
                    new_body['trace'] = new_trace
                    msg['body'] = new_body
                return msg

        return msg


def normalize_stamps(msg):
    """
    Canonicalize the continuum stamps INTO the body — the single place they
    live. Current recordings (and the live wire) already carry
    ``body.eventTime`` + ``body.logSeq``; legacy v2 segments carried the
    stamps at the header with the continuum under ``seq``, so decode moves
    those into the body once and old data reads identically to new. The DAP
    envelope is never a source of truth (its ``seq`` is per-connection
    bookkeeping).

    Args:
        msg: A decoded event dict (mutated in place).

    Returns:
        The same event with body.eventTime/body.logSeq guaranteed.
    """
    body = msg.get('body')
    if not isinstance(body, dict):
        body = {}
        msg['body'] = body
    if not isinstance(body.get('eventTime'), (int, float)) and isinstance(msg.get('eventTime'), (int, float)):
        body['eventTime'] = msg['eventTime']
    if not isinstance(body.get('logSeq'), int) and isinstance(msg.get('seq'), int):
        body['logSeq'] = msg['seq']
    return msg
