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
"""DecisionRecorder: one node's decisions on the current object, without changing the node's shape."""

from types import SimpleNamespace

import pytest

from ai.common.decision import DecisionError, DecisionRecorder, component_id, fingerprint

QUESTIONS = {'is_odd': {'kind': 'yes_no', 'values': ['yes', 'no']}}


def _node(component='writer_1', logical='writer'):
    return SimpleNamespace(
        instance=SimpleNamespace(currentObject=SimpleNamespace(response={}), pipeType={'id': component}),
        IGlobal=SimpleNamespace(glb=SimpleNamespace(logicalType=logical)),
    )


def _doc(text, chunk=0):
    return SimpleNamespace(page_content=text, metadata=SimpleNamespace(chunkId=chunk))


def _group(node, gid='writer_1'):
    return node.instance.currentObject.response['decisions'][gid]


def test_component_id_prefers_the_pipe_id_then_the_logical_type():
    assert component_id(_node('so_7')) == 'so_7'
    assert component_id(_node('', 'anomaly_detector')) == 'anomaly_detector'


def test_record_object_writes_an_object_level_item():
    node = _node()
    rec = DecisionRecorder(node, QUESTIONS, model='m1')
    assert rec.record_object('text', {'is_odd': {'answer': 'yes'}}, preview='abc') == 0
    group = _group(node)
    assert group['writer'] == 'writer' and group['model'] == 'm1' and group['questions'] == QUESTIONS
    assert group['items'] == [
        {'lane': 'text', 'status': 'ok', 'preview': 'abc', 'answers': {'is_odd': {'answer': 'yes'}}}
    ]


def test_record_object_extra_keys_are_merged():
    node = _node()
    rec = DecisionRecorder(node, QUESTIONS)
    rec.record_object(
        'questions',
        {'is_odd': {'answer': 'no'}},
        preview='q',
        extra={'truncated': True, 'size': {'tokens': 9, 'limit': 5}},
    )
    assert _group(node)['items'][0]['truncated'] is True


def test_record_document_stamps_the_doc_and_links_its_chunk():
    node = _node()
    rec = DecisionRecorder(node, QUESTIONS)
    doc = _doc('hello world', chunk=3)
    index = rec.record_document(doc, {'is_odd': {'answer': 'no'}})
    assert index == 0
    assert doc.metadata.decision_refs == {'writer_1': 0}
    item = _group(node)['items'][0]
    assert item['lane'] == 'documents' and item['item'] == {'chunkId': 3} and item['preview'] == 'hello world'


def test_record_document_without_metadata_is_an_error():
    rec = DecisionRecorder(_node(), QUESTIONS)
    with pytest.raises(DecisionError, match='metadata'):
        rec.record_document(SimpleNamespace(page_content='x', metadata=None), {'is_odd': {'answer': 'no'}})


def test_record_table_keys_by_fingerprint_with_a_running_index():
    node = _node()
    rec = DecisionRecorder(node, QUESTIONS)
    rec.record_table('a|b', {'is_odd': {'answer': 'yes'}})
    rec.record_table('c|d', {'is_odd': {'answer': 'no'}})
    items = _group(node)['items']
    assert [i['item'] for i in items] == [
        {'table_index': 0, 'fingerprint': fingerprint('a|b')},
        {'table_index': 1, 'fingerprint': fingerprint('c|d')},
    ]


def test_record_status_links_a_document_and_carries_size():
    node = _node()
    rec = DecisionRecorder(node, QUESTIONS)
    doc = _doc('too big', chunk=1)
    rec.record_status('documents', 'too_long', doc=doc, size={'tokens': 99, 'limit': 10})
    item = _group(node)['items'][0]
    assert item == {
        'lane': 'documents',
        'status': 'too_long',
        'preview': 'too big',
        'item': {'chunkId': 1},
        'size': {'tokens': 99, 'limit': 10},
    }
    assert doc.metadata.decision_refs == {'writer_1': 0}


def test_bad_questions_fail_at_construction():
    with pytest.raises(DecisionError):
        DecisionRecorder(_node(), {})
