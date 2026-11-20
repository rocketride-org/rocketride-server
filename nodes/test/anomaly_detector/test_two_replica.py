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

"""
The two-replica test of anomaly_detector (plan 4.3, section 12, Step 3c PR 5).

The calls of one control alternate between two replicas, each with its own
import of the node and its own IGlobal, sharing only the server's state store:
every answer must equal a single replica's, a series is scored from one
history whichever replica serves it, and one owner's values never enter
another owner's series. The node's settings come from the engine-resolved
schema, so the per-call params (a selector among them) are resolved exactly
as on a running engine.
"""

from ai.common.schema import Doc, DocMetadata

from ..framework.replicas import NODES_DIR, Call, Owner, run_alternating_and_alone

# ==== The node and its calls =====================================================

NODE_DIR = NODES_DIR / 'anomaly_detector'
NODE_ID = 'anomaly_1'

#: A steady series with two spikes, then a level shift.
VALUES = [100, 101, 99, 100, 102, 98, 100, 101, 160, 100, 99, 101, 100, 40, 100, 100, 130, 131, 129, 130]

ALICE = Owner(orgId='org-a', userId='alice')
BOB = Owner(orgId='org-b', userId='bob')


def _text(owner, value, **params):
    """One call carrying one value on the text lane."""
    return Call(owner=owner, params=params, invoke=lambda instance: instance.writeText(str(value)))


def _documents(owner, rows, **params):
    """One call carrying documents whose metadata hold the metric and the host."""

    def invoke(instance):
        docs = [
            Doc(page_content='', metadata=DocMetadata(objectId=f'o{i}', chunkId=0, **row)) for i, row in enumerate(rows)
        ]
        instance.writeDocuments(docs)

    return Call(owner=owner, params=params, invoke=invoke)


def _texts(outputs):
    """The text each call forwarded."""
    return [args[0] for call in outputs for name, args in call if name == 'writeText']


def _severities(outputs):
    """The severity of every document each call forwarded."""
    return [
        [doc.metadata.anomaly_severity for doc in args[0]]
        for call in outputs
        for name, args in call
        if name == 'writeDocuments'
    ]


def _run(calls):
    """Play the calls alternately on two replicas and on one."""
    return run_alternating_and_alone(NODE_DIR, 'anomaly_detector', NODE_ID, calls)


# ==== One series, two replicas ====================================================


def test_one_series_scores_identically_on_two_replicas():
    alternating, reference = _run([_text(ALICE, value) for value in VALUES])
    assert alternating == reference
    assert _texts(reference)[8].startswith('160 [ANOMALY: critical')
    assert _texts(reference)[13].startswith('40 [ANOMALY: critical')


def test_per_call_params_reach_the_detector_on_either_replica():
    # The method is a selector param: a call switches it, and the branch's own
    # sensitivity and window apply; the series is a param too
    calls = [_text(ALICE, value) for value in VALUES[:8]]
    calls += [_text(ALICE, 160, method='iqr', **{'iqr.sensitivity': 0.5})]
    calls += [_text(ALICE, value, series='cpu') for value in (5, 5, 6, 5, 50)]
    calls += [_text(ALICE, 101, method='rolling_avg', **{'rolling_avg.windowSize': 10})]
    alternating, reference = _run(calls)
    assert alternating == reference
    texts = _texts(reference)
    assert '[ANOMALY' in texts[8]
    # The cpu series starts empty: its own history, not the default one's
    assert texts[9:13] == ['5', '5', '6', '5']


def test_documents_split_into_series_by_the_series_field():
    owner = Owner(orgId='org-a', userId='alice', config=(('seriesField', 'host'),))
    calls = [
        _documents(owner, [{'host': 'web-1', 'value': 100 + i % 3 - 1}, {'host': 'web-2', 'value': 10 + i % 3 - 1}])
        for i in range(8)
    ]
    calls += [_documents(owner, [{'host': 'web-1', 'value': 10}, {'host': 'web-2', 'value': 10}])]
    alternating, reference = _run(calls)
    assert alternating == reference
    # 10 is critical for web-1 (it lives near 100) and normal for web-2
    assert _severities(reference)[-1] == ['critical', 'normal']


# ==== Owners never see each other's series ========================================


def test_another_owners_values_never_enter_a_series():
    # Bob shares the series name, the node id and the address, and sends what
    # would make Alice's spike look normal; Alice's answers stay her own
    alice = [_text(ALICE, value) for value in VALUES]
    bob = [_text(BOB, 160) for _ in VALUES]
    interleaved = [call for pair in zip(alice, bob) for call in pair]

    together, _reference = _run(interleaved)
    alone, _ = _run(alice)
    assert _texts(together)[0::2] == _texts(alone)
    assert all('[ANOMALY' not in text for text in _texts(together)[1::2][2:])
