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
"""Writer-neutral decisions on ``currentObject.response['decisions']`` (spec §3).

Any node may record decisions here. A gate reads them back with ``resolve`` and never
needs to know which node wrote what. Nothing in this module is System One specific.
"""

from __future__ import annotations

import hashlib
import json
import math
from dataclasses import dataclass

DECISIONS_KEY = 'decisions'
RESULT_TYPES_KEY = 'result_types'
OK = 'ok'
UNCERTAIN = 'uncertain'
PREVIEW_CHARS = 80
_ITEM_KEYS = frozenset({'lane', 'status', 'preview', 'item', 'answers', 'size', 'truncated'})


class DecisionError(Exception):
    """A decision is malformed, missing or ambiguous; the object must fail."""


@dataclass(frozen=True)
class NotDecided:
    """The writer saw the item but recorded no answer; ``status`` says why."""

    status: str
    group: str


def preview(text) -> str:
    """Return ``text`` on one line, cut to ``PREVIEW_CHARS`` characters."""
    flat = ' '.join(str(text or '').split())
    return flat if len(flat) <= PREVIEW_CHARS else flat[: PREVIEW_CHARS - 1] + '…'


def fingerprint(table: str) -> str:
    """Return the durable key of a table: SHA-256 over its exact text."""
    return 'sha256:' + hashlib.sha256(table.encode('utf-8')).hexdigest()


def stamp(doc, group_id: str, index: int) -> None:
    """Point ``doc`` at item ``index`` of group ``group_id`` via ``metadata.decision_refs``."""
    if doc.metadata is None:
        raise DecisionError('stamp() needs a document with metadata')
    refs = dict(getattr(doc.metadata, 'decision_refs', None) or {})
    refs[group_id] = index
    doc.metadata.decision_refs = refs


def snapshot(response) -> dict | None:
    """Return a plain copy of ``response['decisions']``, or None when nothing has been recorded yet."""
    if DECISIONS_KEY not in response:
        return None
    return _plain(response[DECISIONS_KEY])


def record(response, group_id: str, *, writer: str, questions: dict, item: dict, model=None, usage=None) -> int:
    """Validate ``item``, append it to ``response['decisions'][group_id]`` and return its index.

    Args:
        response: ``currentObject.response`` (an engine ``IJson``) or a plain dict in tests.
        group_id: The writer's component id, e.g. ``decision_ollama_1``.
        writer: The writer's node type, e.g. ``decision_ollama``.
        questions: ``{name: {'kind': ..., ...}}``; fixed by the group's first write.
        item: One decision item (spec §3.2).
        model: Optional model name; fixed by the group's first write.
        usage: Optional numbers that add up across writes, e.g. ``{'calls': 1, 'input_tokens': 412}``.

    The path is looked up fresh on every access, so no ``IJson`` view outlives one statement.
    """
    if not isinstance(group_id, str) or not group_id:
        raise DecisionError('group_id must be a non-empty string (the writer component id)')
    if not isinstance(writer, str) or not writer:
        raise DecisionError('writer must be a non-empty string (the writer node type)')
    _check_questions(questions)
    if not isinstance(item, dict):
        raise DecisionError('item must be a dict')
    item = _round(_plain(item))
    _check_item(item, questions)
    if usage is not None and not isinstance(usage, dict):
        raise DecisionError('usage must be a dict')

    if DECISIONS_KEY not in response:
        response[DECISIONS_KEY] = {}
    if RESULT_TYPES_KEY not in response:
        response[RESULT_TYPES_KEY] = {}
    response[RESULT_TYPES_KEY][DECISIONS_KEY] = DECISIONS_KEY

    if group_id not in response[DECISIONS_KEY]:
        group = {'writer': writer, 'questions': _plain(questions), 'items': []}
        if model is not None:
            group['model'] = model
        response[DECISIONS_KEY][group_id] = group
    elif response[DECISIONS_KEY][group_id]['writer'] != writer or _plain(
        response[DECISIONS_KEY][group_id]['questions']
    ) != _plain(questions):
        raise DecisionError(f'{group_id}: already holds decisions from a different writer or question set')

    if usage:
        if 'usage' not in response[DECISIONS_KEY][group_id]:
            response[DECISIONS_KEY][group_id]['usage'] = {}
        for key, value in _round(_plain(usage)).items():
            totals = response[DECISIONS_KEY][group_id]['usage']
            if _is_number(value) and key in totals and _is_number(totals[key]):
                totals[key] = _round(totals[key] + value)
            else:
                totals[key] = value

    response[DECISIONS_KEY][group_id]['items'].append(item)
    return len(response[DECISIONS_KEY][group_id]['items']) - 1


def resolve(decisions, lane: str, question: str, *, refs=None, table_key=None):
    """Find the answer to ``question`` for one incoming item (spec §3.4).

    Args:
        decisions: A ``snapshot()`` of ``response['decisions']`` (or None).
        lane: The lane the item arrived on.
        question: The question name.
        refs: The document's ``metadata.decision_refs`` (documents lane).
        table_key: ``fingerprint(table)`` (table lane).

    Returns:
        The answer dict, ``NotDecided`` when the matching item has a non-ok status, or None when
        nothing answers ``question`` for this item.

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
        return NotDecided(status=str(item.get('status')), group=gid)
    return item['answers'][question]


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


def _plain(value):
    """Return a plain-Python copy of a dict/list or of an engine ``IJson`` view."""
    if value is None or isinstance(value, (dict, list, str, int, float, bool)):
        return json.loads(json.dumps(value))
    return json.loads(str(value))


def _round(value):
    if isinstance(value, float):
        return round(value, 4)
    if isinstance(value, dict):
        return {key: _round(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_round(item) for item in value]
    return value


def _is_number(value) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _check_questions(questions) -> None:
    if not isinstance(questions, dict) or not questions:
        raise DecisionError('questions must be a non-empty dict')
    for name, definition in questions.items():
        if not isinstance(name, str) or not name:
            raise DecisionError(f'question name {name!r} must be a non-empty string')
        if not isinstance(definition, dict) or not isinstance(definition.get('kind'), str) or not definition['kind']:
            raise DecisionError(f'question {name!r} needs a "kind"')


def _check_answer(name: str, answer) -> None:
    if not isinstance(answer, dict) or 'answer' not in answer:
        raise DecisionError(f'{name}: each answer must be a dict with an "answer"')
    value = answer['answer']
    if not isinstance(value, (str, int, float, bool)) or (isinstance(value, float) and not math.isfinite(value)):
        raise DecisionError(f'{name}: "answer" must be a string, a finite number or a boolean, got {value!r}')
    if 'confidence' in answer and not (_is_number(answer['confidence']) and 0.0 <= answer['confidence'] <= 1.0):
        raise DecisionError(f'{name}: "confidence" must be a number in [0, 1]')
    if 'index' in answer and (not isinstance(answer['index'], int) or isinstance(answer['index'], bool)):
        raise DecisionError(f'{name}: "index" must be an integer')
    if 'best' in answer and value != UNCERTAIN:
        raise DecisionError(f'{name}: "best" is only allowed with answer "{UNCERTAIN}"')


def _check_item(item: dict, questions: dict) -> None:
    unknown = set(item) - _ITEM_KEYS
    if unknown:
        raise DecisionError(f'item has unknown keys {sorted(unknown)}')
    if not isinstance(item.get('lane'), str) or not item['lane']:
        raise DecisionError('item needs a "lane"')
    status = item.get('status')
    if not isinstance(status, str) or not status:
        raise DecisionError('item needs a "status"')
    if 'item' in item and not isinstance(item['item'], dict):
        raise DecisionError('"item" must be a dict')
    if 'preview' in item and not isinstance(item['preview'], str):
        raise DecisionError('"preview" must be a string')
    if status != OK:
        if 'answers' in item:
            raise DecisionError(f'an item with status "{status}" must not carry answers')
        return
    answers = item.get('answers')
    if not isinstance(answers, dict) or set(answers) != set(questions):
        raise DecisionError(f'an "ok" item must answer exactly the group questions {sorted(questions)}')
    for name, answer in answers.items():
        _check_answer(name, answer)
