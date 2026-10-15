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
"""Decision recording for every node: the code behind ``IInstanceBase.recordDecision`` (internal).

A node records its own questions and answers with ``self.recordDecision(...)``; nothing in this
module is public node API. The Gate's reader side lives in ``ai.common.decision`` and imports the
names both sides share from here. Standard library only, so this module never needs the engine.
"""

from __future__ import annotations

import hashlib
import json
import math

DECISIONS_KEY = 'decisions'
RESULT_TYPES_KEY = 'result_types'
OK = 'ok'
UNCERTAIN = 'uncertain'
PREVIEW_CHARS = 80
_ITEM_KEYS = frozenset({'lane', 'status', 'preview', 'item', 'answers', 'size', 'truncated'})


class DecisionError(Exception):
    """A decision is malformed, missing or ambiguous; the object must fail."""


def _one_line(text) -> str:
    flat = ' '.join(str(text or '').split())
    return flat if len(flat) <= PREVIEW_CHARS else flat[: PREVIEW_CHARS - 1] + '…'


def preview(text) -> str:
    """Return ``text`` on one line, cut to ``PREVIEW_CHARS`` characters."""
    return _one_line(text)


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
    check_questions(questions)
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


def check_questions(questions) -> None:
    """Raise DecisionError unless ``questions`` is a non-empty ``{name: {'kind': ...}}`` header."""
    if not isinstance(questions, dict) or not questions:
        raise DecisionError('questions must be a non-empty dict')
    for name, definition in questions.items():
        if not isinstance(name, str) or not name:
            raise DecisionError(f'question name {name!r} must be a non-empty string')
        if not isinstance(definition, dict) or not isinstance(definition.get('kind'), str) or not definition['kind']:
            raise DecisionError(f'question {name!r} needs a "kind"')
        values = definition.get('values')
        if values is not None and (
            not isinstance(values, list)
            or not values
            or not all(isinstance(v, (str, int, float, bool)) for v in values)
        ):
            raise DecisionError(f'question {name!r}: "values" must be a non-empty list of strings, numbers or booleans')


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


def component_id(node) -> str:
    """Return the node's component id (e.g. ``decision_ollama_1``), falling back to its logical type."""
    pipe_type = getattr(getattr(node, 'instance', None), 'pipeType', None)
    cid = pipe_type.get('id') if isinstance(pipe_type, dict) else getattr(pipe_type, 'id', '')
    return str(cid or getattr(getattr(getattr(node, 'IGlobal', None), 'glb', None), 'logicalType', 'decision'))


def _writer(node) -> str:
    logical = getattr(getattr(getattr(node, 'IGlobal', None), 'glb', None), 'logicalType', None)
    return str(logical or component_id(node))


def _table_index(response, group_id: str) -> int:
    """How many table decisions this group already holds on this object (so it restarts per object)."""
    if DECISIONS_KEY not in response or group_id not in response[DECISIONS_KEY]:
        return 0
    return sum(1 for item in _plain(response[DECISIONS_KEY][group_id]['items']) if item.get('lane') == 'table')


def record_decision(
    node,
    questions: dict,
    answers: dict | None = None,
    *,
    lane: str | None = None,
    doc=None,
    table: str | None = None,
    status: str = OK,
    preview: str | None = None,
    size: dict | None = None,
    truncated: bool = False,
    model: str | None = None,
    usage: dict | None = None,
) -> int:
    """Record one decision of ``node`` on its current object; return the item's index in its group.

    ``doc=`` links the decision to one document (stamping ``metadata.decision_refs``), ``table=``
    links it to one table by fingerprint, and otherwise ``lane=`` names the whole-object lane.
    A non-ok ``status`` (``too_long``, ``unsupported``, ...) carries no answers.
    """
    if doc is not None and table is not None:
        raise DecisionError('pass doc= or table=, not both')
    target = 'documents' if doc is not None else 'table' if table is not None else None
    if target is not None:
        if lane not in (None, target):
            raise DecisionError(f'lane={lane!r} does not match the {target} it is linked to')
        if preview is not None:
            raise DecisionError('preview comes from the document or table; do not pass it')
        lane = target
    elif not lane:
        raise DecisionError('say what the decision is about: pass doc=, table= or lane=')

    response = getattr(node.instance.currentObject, 'response', None)
    if response is None:
        raise DecisionError('recordDecision needs a current object; call it from a lane method or closing()')
    group_id = component_id(node)
    item = {'lane': lane, 'status': status}
    if doc is not None:
        if getattr(doc, 'metadata', None) is None:
            raise DecisionError('a document needs metadata to carry its decision_refs; give it metadata first')
        item['preview'] = _one_line(doc.page_content)
        item['item'] = {'chunkId': doc.metadata.chunkId}
    elif table is not None:
        item['preview'] = _one_line(table)
        item['item'] = {'table_index': _table_index(response, group_id), 'fingerprint': fingerprint(table)}
    elif preview is not None:
        item['preview'] = preview
    if size is not None:
        item['size'] = size
    if truncated:
        item['truncated'] = True
    if answers is not None:
        item['answers'] = answers

    index = record(response, group_id, writer=_writer(node), questions=questions, item=item, model=model, usage=usage)
    if doc is not None:
        stamp(doc, group_id, index)
    return index
