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

"""IInstanceBase.recordDecision: any node records its own questions and answers on the current object."""

import ast
import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

from rocketlib import IInstanceBase, IJson
from rocketlib.decisions import DecisionError, component_id, fingerprint, record_decision

QUESTIONS = {'is_odd': {'kind': 'yes_no', 'values': ['yes', 'no']}}
YES = {'is_odd': {'answer': 'yes'}}
NO = {'is_odd': {'answer': 'no'}}


def _node(component='writer_1', logical='writer', response=None):
    return SimpleNamespace(
        instance=SimpleNamespace(
            currentObject=SimpleNamespace(response={} if response is None else response), pipeType={'id': component}
        ),
        IGlobal=SimpleNamespace(glb=SimpleNamespace(logicalType=logical)),
    )


def _doc(text, chunk=0):
    return SimpleNamespace(page_content=text, metadata=SimpleNamespace(chunkId=chunk))


def _group(node, gid='writer_1'):
    return node.instance.currentObject.response['decisions'][gid]


class _Writer(IInstanceBase):
    """A plain node: no open(), no imports, just the inherited method."""

    def __init__(self):
        node = _node()
        self.instance, self.IGlobal = node.instance, node.IGlobal


def test_component_id_prefers_the_pipe_id_then_the_logical_type():
    assert component_id(_node('so_7')) == 'so_7'
    assert component_id(_node('', 'anomaly_detector')) == 'anomaly_detector'


def test_inherited_method_records_on_the_current_object():
    node = _Writer()
    assert node.recordDecision(QUESTIONS, YES, lane='text', preview='abc', model='m1') == 0
    group = node.instance.currentObject.response['decisions']['writer_1']
    assert group['writer'] == 'writer' and group['model'] == 'm1' and group['questions'] == QUESTIONS
    assert group['items'] == [{'lane': 'text', 'status': 'ok', 'preview': 'abc', 'answers': YES}]


def test_whole_object_decision_can_carry_truncated_and_size():
    node = _node()
    record_decision(node, QUESTIONS, NO, lane='questions', preview='q', truncated=True, size={'tokens': 9, 'limit': 5})
    item = _group(node)['items'][0]
    assert item['truncated'] is True and item['size'] == {'tokens': 9, 'limit': 5}


def test_document_decision_stamps_the_doc_and_links_its_chunk():
    node = _node()
    doc = _doc('hello world', chunk=3)
    assert record_decision(node, QUESTIONS, NO, doc=doc) == 0
    assert doc.metadata.decision_refs == {'writer_1': 0}
    assert _group(node)['items'][0] == {
        'lane': 'documents',
        'status': 'ok',
        'preview': 'hello world',
        'item': {'chunkId': 3},
        'answers': NO,
    }


def test_document_without_metadata_is_an_error():
    with pytest.raises(DecisionError, match='metadata'):
        record_decision(_node(), QUESTIONS, NO, doc=SimpleNamespace(page_content='x', metadata=None))


def test_recording_without_a_current_object_is_an_error():
    node = _node()
    node.instance.currentObject = None
    with pytest.raises(DecisionError, match='current object'):
        record_decision(node, QUESTIONS, YES, lane='text')


def test_table_decisions_key_by_fingerprint_with_an_index():
    node = _node()
    record_decision(node, QUESTIONS, YES, table='a|b')
    record_decision(node, QUESTIONS, NO, table='c|d')
    assert [i['item'] for i in _group(node)['items']] == [
        {'table_index': 0, 'fingerprint': fingerprint('a|b')},
        {'table_index': 1, 'fingerprint': fingerprint('c|d')},
    ]


def test_table_index_restarts_on_a_new_object():
    node = _Writer()
    node.recordDecision(QUESTIONS, YES, table='a|b')
    node.recordDecision(QUESTIONS, YES, table='c|d')
    node.instance.currentObject = SimpleNamespace(response={})  # the engine moves to the next object
    node.recordDecision(QUESTIONS, NO, table='e|f')
    assert _group(node)['items'][0]['item']['table_index'] == 0


def test_table_index_counts_on_engine_json():
    response = IJson()
    node = _node(response=response)
    record_decision(node, QUESTIONS, YES, table='a|b')
    record_decision(node, QUESTIONS, NO, table='c|d')
    record_decision(node, QUESTIONS, NO, lane='text')
    assert record_decision(node, QUESTIONS, YES, table='e|f') == 3
    items = json.loads(str(response))['decisions']['writer_1']['items']
    assert [items[i]['item']['table_index'] for i in (0, 1, 3)] == [0, 1, 2]


def test_status_links_a_document_and_carries_size():
    node = _node()
    doc = _doc('too big', chunk=1)
    record_decision(node, QUESTIONS, status='too_long', doc=doc, size={'tokens': 99, 'limit': 10})
    assert _group(node)['items'][0] == {
        'lane': 'documents',
        'status': 'too_long',
        'preview': 'too big',
        'item': {'chunkId': 1},
        'size': {'tokens': 99, 'limit': 10},
    }
    assert doc.metadata.decision_refs == {'writer_1': 0}


def test_status_on_a_table_and_on_a_whole_object():
    node = _node()
    record_decision(node, QUESTIONS, status='too_long', table='a|b', size={'bytes': 9, 'limit': 1})
    record_decision(node, QUESTIONS, status='unsupported', lane='json', preview='{}')
    first, second = _group(node)['items']
    assert first['lane'] == 'table' and first['item']['table_index'] == 0 and 'answers' not in first
    assert second == {'lane': 'json', 'status': 'unsupported', 'preview': '{}'}


def test_a_status_with_answers_is_an_error():
    with pytest.raises(DecisionError, match='must not carry answers'):
        record_decision(_node(), QUESTIONS, YES, status='unsupported', lane='text')


def test_ok_without_answers_is_an_error():
    with pytest.raises(DecisionError, match='answer exactly'):
        record_decision(_node(), QUESTIONS, lane='text')


def test_bad_questions_are_an_error():
    with pytest.raises(DecisionError):
        record_decision(_node(), {}, YES, lane='text')


@pytest.mark.parametrize(
    'kwargs, message',
    [
        ({'doc': 'DOC', 'table': 'a|b'}, 'not both'),
        ({'doc': 'DOC', 'lane': 'text'}, 'does not match'),
        ({'table': 'a|b', 'lane': 'documents'}, 'does not match'),
        ({}, 'doc=, table= or lane='),
        ({'doc': 'DOC', 'preview': 'p'}, 'preview'),
    ],
)
def test_ambiguous_targets_raise_and_record_nothing(kwargs, message):
    node = _node()
    kwargs = {k: (_doc('d') if v == 'DOC' else v) for k, v in kwargs.items()}
    with pytest.raises(DecisionError, match=message):
        record_decision(node, QUESTIONS, YES, **kwargs)
    assert 'decisions' not in node.instance.currentObject.response


def test_decisions_module_imports_only_the_standard_library():
    path = Path(__file__).resolve().parents[1] / 'lib' / 'rocketlib' / 'decisions.py'
    tree = ast.parse(path.read_text(encoding='utf-8'))
    modules = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom):
            assert node.level == 0, 'decisions.py must not use relative imports'
            modules.add(node.module.split('.')[0])
        elif isinstance(node, ast.Import):
            modules.update(alias.name.split('.')[0] for alias in node.names)
    assert modules <= set(sys.stdlib_module_names) | {'__future__'}, modules
