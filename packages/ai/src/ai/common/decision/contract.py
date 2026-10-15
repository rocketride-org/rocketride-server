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
"""Reading decisions back (spec §3.4): the Gate's side of ``currentObject.response['decisions']``.

Writers record with ``IInstanceBase.recordDecision`` (``rocketlib.decisions``); readers find an
item's answer here and never need to know which node wrote it.
"""

from __future__ import annotations

from dataclasses import dataclass

from rocketlib.decisions import DECISIONS_KEY, OK, DecisionError, _plain


@dataclass(frozen=True)
class NotDecided:
    """The writer saw the item but recorded no answer; ``status`` says why."""

    status: str
    group: str


def snapshot(response) -> dict | None:
    """Return a plain copy of ``response['decisions']``, or None when nothing has been recorded yet."""
    if DECISIONS_KEY not in response:
        return None
    return _plain(response[DECISIONS_KEY])


def resolve_hit(decisions, lane: str, question: str, *, refs=None, table_key=None):
    """Find the answer to ``question`` for one incoming item (spec §3.4) and the group that gave it.

    Args:
        decisions: A ``snapshot()`` of ``response['decisions']`` (or None).
        lane: The lane the item arrived on.
        question: The question name.
        refs: The document's ``metadata.decision_refs`` (documents lane).
        table_key: ``fingerprint(table)`` (table lane).

    Returns:
        ``(group_id, answer_or_NotDecided)``: the answer dict, or ``NotDecided`` when the matching item
        has a non-ok status. None when nothing answers ``question`` for this item.

    Raises:
        DecisionError: two writers answer the same question for the item, or the match is ambiguous.
    """
    groups = {gid: group for gid, group in (decisions or {}).items() if question in (group.get('questions') or {})}
    hits = _item_hits(groups, refs, table_key) or _object_hits(groups, lane)
    if not hits:
        return None
    if len(hits) > 1:
        names = ' and '.join(gid for gid, _ in hits)
        raise DecisionError(f'"{question}" is answered by both {names}; rename one')
    gid, item = hits[0]
    if item.get('status') != OK:
        return gid, NotDecided(status=str(item.get('status')), group=gid)
    return gid, item['answers'][question]


def resolve(decisions, lane: str, question: str, *, refs=None, table_key=None):
    """Find the answer to ``question`` for one incoming item (spec §3.4); see ``resolve_hit``."""
    hit = resolve_hit(decisions, lane, question, refs=refs, table_key=table_key)
    return None if hit is None else hit[1]


def _item_hits(groups: dict, refs, table_key) -> list:
    hits = []
    for gid, index in (refs or {}).items():
        if gid not in groups:
            continue
        items = groups[gid].get('items') or []
        if not isinstance(index, int) or isinstance(index, bool) or not 0 <= index < len(items):
            raise DecisionError(f'decision_refs points at item {index!r} of {gid}, which does not exist')
        hits.append((gid, items[index]))
    if table_key and not hits:
        for gid, group in groups.items():
            match = next(
                (i for i in group.get('items') or [] if (i.get('item') or {}).get('fingerprint') == table_key), None
            )
            if match is not None:
                hits.append((gid, match))
    return hits


def _object_hits(groups: dict, lane: str) -> list:
    hits = []
    for gid, group in groups.items():
        whole = [i for i in group.get('items') or [] if 'item' not in i]
        for candidates in (
            [i for i in whole if i.get('lane') == lane],
            [i for i in whole if i.get('lane') == 'text'],
            whole,
        ):
            if len(candidates) == 1:
                hits.append((gid, candidates[0]))
                break
            if len(candidates) > 1:
                raise DecisionError(
                    f'{gid} holds {len(candidates)} whole-object decisions that could apply to the {lane} lane'
                )
    return hits
