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
"""Contract on the real engine IJson: nested writes land in place (spec §3.1)."""

import json

from rocketlib import IJson

from ai.common.decision.contract import record, snapshot

QUESTIONS = {'is_spam': {'kind': 'yes_no'}}


def _item(answer):
    return {'lane': 'text', 'status': 'ok', 'answers': {'is_spam': {'answer': answer, 'confidence': 0.5}}}


def test_record_writes_in_place_into_engine_json():
    response = IJson()
    response['text'] = ['hello']
    assert snapshot(response) is None
    assert record(response, 'g1', writer='w', questions=QUESTIONS, item=_item('no'), usage={'calls': 1}) == 0
    assert record(response, 'g1', writer='w', questions=QUESTIONS, item=_item('yes'), usage={'calls': 1}) == 1
    plain = json.loads(str(response))
    assert plain['text'] == ['hello']
    assert plain['result_types'] == {'decisions': 'decisions'}
    assert [i['answers']['is_spam']['answer'] for i in plain['decisions']['g1']['items']] == ['no', 'yes']
    assert plain['decisions']['g1']['usage'] == {'calls': 2}
    assert snapshot(response) == plain['decisions']
