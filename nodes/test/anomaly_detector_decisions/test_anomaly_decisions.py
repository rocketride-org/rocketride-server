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
"""anomaly_detector records a decision per document through IInstanceBase.recordDecision (spec A2 §4.4)."""

import importlib
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

from ai.common.schema import Doc, DocMetadata

NODES_SRC = Path(__file__).parent.parent.parent / 'src' / 'nodes'
# sys.path can hold a package with the same name as the node (see #1687).
while str(NODES_SRC) in sys.path:
    sys.path.remove(str(NODES_SRC))
sys.path.insert(0, str(NODES_SRC))
anomaly_instance = importlib.import_module('anomaly_detector.IInstance')
detector_module = importlib.import_module('anomaly_detector.detector')

# z_score with the services.json defaults.
CONFIG = {
    'method': 'z_score',
    'sensitivity': 2.0,
    'windowSize': 100,
    'warningThreshold': 2.0,
    'criticalThreshold': 3.0,
    'metric': 'value',
}
VALUES = [10, 12, 10, 12, 10, 12, 10, 12, 10, 1000]


class Prevented(Exception):
    pass


def _node(with_detector=True):
    inst = anomaly_instance.IInstance()
    out = {'documents': []}
    inst.instance = SimpleNamespace(
        currentObject=SimpleNamespace(response={}, objectId='obj-1', path='/in', permissionId=0, componentId='c'),
        writeDocuments=out['documents'].append,
        pipeType={'id': 'anomaly_detector_1'},
    )
    detector = detector_module.AnomalyDetector(dict(CONFIG)) if with_detector else None
    inst.IGlobal = SimpleNamespace(glb=SimpleNamespace(logicalType='anomaly_detector'), detector=detector)
    inst.IEndpoint = SimpleNamespace(endpoint=SimpleNamespace(jobConfig={'nodeId': 'n1'}))

    def prevent():
        raise Prevented()

    inst.preventDefault = prevent
    return inst, out


def _doc(i, value):
    return Doc(page_content=f'reading {i}', metadata=DocMetadata(objectId='obj-1', chunkId=i, value=value))


def _run(inst, docs):
    with pytest.raises(Prevented):
        inst.writeDocuments(docs)


def _group(inst):
    return inst.instance.currentObject.response['decisions']['anomaly_detector_1']


def test_each_document_with_metadata_gets_a_decision():
    inst, out = _node()
    _run(inst, [_doc(i, v) for i, v in enumerate(VALUES)])
    items = _group(inst)['items']
    assert len(items) == 10 and all(item['status'] == 'ok' for item in items)
    (forwarded,) = out['documents']
    assert [d.metadata.decision_refs for d in forwarded] == [{'anomaly_detector_1': i} for i in range(10)]
    last = items[-1]['answers']
    assert last['is_anomalous'] == {'answer': 'yes'}
    assert last['severity'] == {'answer': 'critical', 'index': 2}
    assert isinstance(last['score']['answer'], float)
    assert all(item['answers']['is_anomalous']['answer'] == 'no' for item in items[:-1])


def test_questions_header_declares_values():
    inst, _ = _node()
    _run(inst, [_doc(0, 10)])
    assert _group(inst)['questions'] == {
        'is_anomalous': {'kind': 'yes_no', 'values': ['yes', 'no']},
        'severity': {
            'kind': 'rubric',
            'levels': ['normal', 'warning', 'critical'],
            'values': ['normal', 'warning', 'critical'],
        },
        'score': {'kind': 'number'},
    }
    assert _group(inst)['writer'] == 'anomaly_detector'


def test_documents_without_metadata_are_recorded_unsupported():
    inst, out = _node()
    _run(inst, [_doc(0, 10), Doc(page_content='no metadata here'), _doc(2, 12)])
    items = _group(inst)['items']
    assert [item['status'] for item in items] == ['ok', 'unsupported', 'ok']
    assert 'answers' not in items[1]
    (forwarded,) = out['documents']
    assert forwarded[1].metadata is not None and forwarded[1].metadata.chunkId == 0
    assert [d.metadata.decision_refs for d in forwarded] == [{'anomaly_detector_1': i} for i in range(3)]


def test_documents_without_a_usable_metric_are_recorded_unsupported():
    inst, out = _node()
    no_value = Doc(page_content='no value', metadata=DocMetadata(objectId='obj-1', chunkId=1, other=5))
    _run(inst, [_doc(0, 10), no_value, _doc(2, 'abc'), _doc(3, float('nan')), _doc(4, 12)])
    items = _group(inst)['items']
    assert [item['status'] for item in items] == ['ok', 'unsupported', 'unsupported', 'unsupported', 'ok']
    assert all('answers' not in items[i] for i in (1, 2, 3))
    (forwarded,) = out['documents']
    assert [d.metadata.decision_refs for d in forwarded] == [{'anomaly_detector_1': i} for i in range(5)]
    # The existing anomaly_* metadata is still written for the unscored documents.
    assert forwarded[1].metadata.anomaly_is_anomalous is False
    assert forwarded[2].metadata.anomaly_details == 'metric "value" is not numeric'


def test_existing_metadata_fields_are_unchanged():
    inst, out = _node()
    _run(inst, [_doc(i, v) for i, v in enumerate(VALUES)])
    last = out['documents'][0][-1].metadata
    assert last.anomaly_is_anomalous is True and last.anomaly_severity == 'critical'
    assert isinstance(last.anomaly_score, float)


def test_detector_off_records_nothing():
    inst, out = _node(with_detector=False)
    docs = [_doc(0, 10)]
    _run(inst, docs)
    assert out['documents'] == [docs]
    assert 'decisions' not in inst.instance.currentObject.response
