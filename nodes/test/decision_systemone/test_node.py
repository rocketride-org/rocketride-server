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
"""System One node v2: documents and table lanes."""

import pytest

from ai.common.decision import fingerprint, resolve, snapshot
from ai.common.systemone.client import SystemOneError

from .conftest import Doc, Meta, Prevented, group


def _doc(text, chunk=0, **kw):
    return Doc(text, Meta(objectId='o1', parent='a.txt', chunkId=chunk), **kw)


def test_documents_record_one_item_each_and_forward_stamped_copies_once(node):
    originals = [_doc('hello', 0), _doc('world', 1)]
    with pytest.raises(Prevented):
        node.inst.writeDocuments(originals)
    assert len(node.written['documents']) == 1
    forwarded = node.written['documents'][0]
    assert [d.metadata.decision_refs for d in forwarded] == [{'decision_ollama_1': 0}, {'decision_ollama_1': 1}]
    assert all(not hasattr(d.metadata, 'decision_refs') for d in originals)
    g = group(node)
    assert g['writer'] == 'decision_ollama' and g['model'] == 'nimble'
    assert g['questions'] == {'urgent': {'kind': 'yes_no', 'question': 'Is it urgent?', 'threshold': 0.5}}
    assert [i['item'] for i in g['items']] == [{'chunkId': 0}, {'chunkId': 1}]
    assert [i['answers']['urgent']['answer'] for i in g['items']] == ['yes', 'yes']
    assert g['usage'] == {'calls': 2, 'input_tokens': 14}
    assert node.inst.instance.currentObject.response['result_types'] == {'decisions': 'decisions'}
    assert node.client.states == ['hello', 'world']


def test_second_list_continues_item_indexes(node):
    for texts in (['a', 'b'], ['c']):
        with pytest.raises(Prevented):
            node.inst.writeDocuments([_doc(t) for t in texts])
    refs = [d.metadata.decision_refs['decision_ollama_1'] for batch in node.written['documents'] for d in batch]
    assert refs == [0, 1, 2]
    decisions = snapshot(node.inst.instance.currentObject.response)
    assert (
        resolve(decisions, 'documents', 'urgent', refs={'decision_ollama_1': 2})
        == group(node)['items'][2]['answers']['urgent']
    )


def test_too_long_document_is_recorded_warned_and_still_forwarded(node):
    with pytest.raises(Prevented):
        node.inst.writeDocuments([_doc('x' * 2000, 0), _doc('hello', 1)])
    first, second = group(node)['items']
    assert first['status'] == 'too_long' and first['size']['limit'] == 400 and 'answers' not in first
    assert second['status'] == 'ok'
    assert node.client.states == ['hello']  # no paid call for the too-long one
    assert any('too_long' in w for w in node.warnings)
    assert len(node.written['documents'][0]) == 2


def test_non_text_document_fails_before_any_call(node):
    with pytest.raises(ValueError, match='convert this content to text first'):
        node.inst.writeDocuments([_doc('hello'), _doc('', type='Image')])
    assert node.client.states == []
    assert 'decisions' not in node.inst.instance.currentObject.response


def test_empty_document_fails_before_any_call(node):
    with pytest.raises(ValueError, match='no text to decide on'):
        node.inst.writeDocuments([_doc('hello'), _doc('   ')])
    assert node.client.states == []


def test_backend_too_large_becomes_too_long(node):
    node.client.error = SystemOneError('too_large', '413', status=413)
    with pytest.raises(Prevented):
        node.inst.writeDocuments([_doc('hello')])
    assert group(node)['items'][0]['status'] == 'too_long'
    assert group(node)['items'][0]['size']['rejected_by'] == 'backend'


def test_backend_failure_is_a_pipe_error(node):
    node.client.error = SystemOneError('server', '503 from x')
    with pytest.raises(SystemOneError):
        node.inst.writeDocuments([_doc('hello')])


def test_document_without_metadata_gets_metadata_and_a_ref(node):
    with pytest.raises(Prevented):
        node.inst.writeDocuments([Doc('hello', None)])
    assert node.written['documents'][0][0].metadata.decision_refs == {'decision_ollama_1': 0}


def test_table_gets_a_fingerprint_item_and_is_forwarded_by_default(node):
    assert node.inst.writeTable('| a | b |') is None
    assert node.inst.writeTable('| c |') is None
    items = group(node)['items']
    assert [i['item'] for i in items] == [
        {'table_index': 0, 'fingerprint': fingerprint('| a | b |')},
        {'table_index': 1, 'fingerprint': fingerprint('| c |')},
    ]
    assert items[0]['lane'] == 'table' and items[0]['status'] == 'ok'


def test_table_index_resets_per_object(node):
    node.inst.writeTable('| a |')
    node.inst.open(None)
    node.inst.writeTable('| b |')
    assert group(node)['items'][1]['item']['table_index'] == 0


def test_too_long_table_is_recorded_and_forwarded(node):
    assert node.inst.writeTable('x' * 2000) is None
    assert group(node)['items'][0]['status'] == 'too_long'
    assert node.client.states == []


def test_empty_table_fails(node):
    with pytest.raises(ValueError, match='no content'):
        node.inst.writeTable('  ')


def test_group_id_falls_back_to_logical_type(node):
    node.inst.instance.pipeType = None
    node.inst.IGlobal.glb.logicalType = 'decision_ollama'
    node.inst.writeTable('| a |')
    assert 'decision_ollama' in node.inst.instance.currentObject.response['decisions']
