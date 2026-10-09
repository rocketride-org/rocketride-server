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
"""DecisionRunner v2: one state per call, size policy, too_large, usage (spec §4–§6)."""

import pytest

from ai.common.systemone.client import SystemOneError
from ai.common.systemone.limits import DecisionLimits
from ai.common.systemone.questions import YES_NO, ProtocolError, QuestionSpec
from ai.common.systemone.runner import DecisionRunner, Outcome

SPECS = [QuestionSpec('urgent', YES_NO, 'Is it urgent?')]
LIMITS = DecisionLimits(max_options=26, max_levels=26, max_questions=64, max_state_tokens=400, chars_per_token=4.0)
REPLY = {
    'model': 'nimble',
    'answers': {'urgent': {'type': 'noul', 'noul': 0.9}},
    'usage': {'input_tokens': 7, 'output_tokens': 1},
}


class FakeClient:
    def __init__(self, *replies):
        self.replies = list(replies) or [REPLY]
        self.calls = []

    def decide(self, model, state, questions):
        self.calls.append((model, state, questions))
        reply = self.replies.pop(0) if len(self.replies) > 1 else self.replies[0]
        if isinstance(reply, Exception):
            raise reply
        return reply


def _runner(client=None, limits=LIMITS, **kw):
    return DecisionRunner(client or FakeClient(), 'nimble', SPECS, limits, **kw)


def test_decide_returns_contract_answers_and_usage():
    client = FakeClient()
    outcome = _runner(client).decide('hello', source='n1')
    assert outcome == Outcome(
        answers={'urgent': {'answer': 'yes', 'confidence': pytest.approx(0.8), 'probability': 0.9}},
        usage={'calls': 1, 'input_tokens': 7, 'output_tokens': 1},
    )
    assert client.calls[0][0] == 'nimble' and client.calls[0][1] == 'hello'


def test_runner_exposes_model_specs_and_question_header():
    runner = _runner()
    assert runner.model == 'nimble' and runner.specs == SPECS
    assert runner.questions == {'urgent': {'kind': 'yes_no', 'question': 'Is it urgent?', 'threshold': 0.5}}


def test_oversize_is_none_when_it_fits_and_a_size_when_not():
    runner = _runner()
    assert runner.oversize('hello') is None
    size = runner.oversize('x' * 2000)
    assert size['limit'] == 400 and size['tokens'] > 400


def test_oversize_checks_body_bytes():
    limits = DecisionLimits(26, 26, 64, 100_000, 4.0, max_body_bytes=300)
    size = _runner(limits=limits).oversize('é' * 200)
    assert size == {'bytes': size['bytes'], 'limit': 300} and size['bytes'] > 300


def test_decide_on_too_long_input_makes_no_call():
    client = FakeClient()
    outcome = _runner(client).decide('x' * 2000, source='n1')
    assert outcome.answers is None and outcome.size['limit'] == 400
    assert client.calls == []


def test_backend_too_large_is_reported_as_size_not_retried():
    client = FakeClient(SystemOneError('too_large', '413 from x', status=413))
    outcome = _runner(client).decide('hello', source='n1')
    assert outcome.answers is None and outcome.size['rejected_by'] == 'backend'
    assert len(client.calls) == 1


@pytest.mark.parametrize('kind', ['auth', 'not_found', 'server', 'network', 'invalid'])
def test_other_backend_errors_raise(kind):
    with pytest.raises(SystemOneError):
        _runner(FakeClient(SystemOneError(kind, 'boom'))).decide('hello', source='n1')


@pytest.mark.parametrize(
    'reply',
    [
        'not json object',
        {'answers': 'nope'},
        {'answers': {}},
        {'answers': {'urgent': {'type': 'choice'}}},
    ],
)
def test_bad_replies_are_protocol_errors(reply):
    with pytest.raises(ProtocolError):
        _runner(FakeClient(reply)).decide('hello', source='n1')


def test_state_includes_selected_metadata():
    runner = _runner(state_metadata=('parent',))
    assert runner.state('hi', {'parent': 'a.txt', 'other': 1}) == {'content': 'hi', 'parent': 'a.txt'}
    assert runner.state('hi', None) == 'hi'


def test_fit_question_drops_history_oldest_first_and_stops_once_it_fits():
    runner = _runner()
    state = {
        'question': 'Is this urgent?',
        'history': [{'role': 'user', 'content': 'old ' * 100}, {'role': 'user', 'content': 'new'}],
        'context': [],
        'documents': ['first', 'second'],
    }
    fitted, size = runner.fit_question(state)
    assert size is not None and size['limit'] == 400
    assert fitted['history'] == [{'role': 'user', 'content': 'new'}]
    assert fitted['documents'] == ['first', 'second']  # documents are only dropped once history is gone
    assert runner.oversize(fitted) is None
    assert len(state['history']) == 2  # the caller's state is untouched


def test_fit_question_drops_all_history_before_documents_last_first():
    state = {
        'question': 'Is this urgent?',
        'history': [{'role': 'user', 'content': 'tiny'}],
        'context': [],
        'documents': ['first', 'second ' * 100],
    }
    fitted, _ = _runner().fit_question(state)
    assert fitted['history'] == []
    assert fitted['documents'] == ['first']


def test_fit_question_returns_none_size_when_it_already_fits():
    state = {'question': 'q', 'history': [], 'context': [], 'documents': []}
    assert _runner().fit_question(state) == (state, None)


def test_fit_question_raises_when_the_question_alone_is_too_long():
    state = {'question': 'q' * 3000, 'history': [{'role': 'user', 'content': 'x'}], 'context': [], 'documents': []}
    with pytest.raises(ValueError, match='question does not fit'):
        _runner().fit_question(state)


def test_fit_question_blames_the_context_too_when_context_is_present():
    state = {'question': 'q', 'history': [], 'context': ['c' * 3000], 'documents': []}
    with pytest.raises(ValueError, match=r'question and its context do not fit the model limit \(400\)') as caught:
        _runner().fit_question(state)
    assert 'even without history and documents' in str(caught.value)


def test_fit_question_message_names_only_the_question_when_there_is_no_context():
    state = {'question': 'q' * 3000, 'history': [], 'context': [], 'documents': []}
    with pytest.raises(ValueError) as caught:
        _runner().fit_question(state)
    assert 'context' not in str(caught.value)


@pytest.mark.parametrize('kind', ['server', 'invalid'])
def test_backend_error_body_goes_to_debug_only(kind):
    debug = []
    client = FakeClient(SystemOneError(kind, 'boom', body='SECRET DOC TEXT'))
    with pytest.raises(SystemOneError) as caught:
        _runner(client, debug=debug.append).decide('hello', source='n1')
    assert any('SECRET DOC TEXT' in line for line in debug)
    assert 'SECRET DOC TEXT' not in str(caught.value)


def test_too_large_body_goes_to_debug_only_and_returns_an_outcome():
    debug = []
    client = FakeClient(SystemOneError('too_large', '413 from x', status=413, body='SECRET DOC TEXT'))
    outcome = _runner(client, debug=debug.append).decide('hello', source='n1')
    assert outcome.answers is None and outcome.size['rejected_by'] == 'backend'
    assert any('SECRET DOC TEXT' in line for line in debug)
    assert 'SECRET DOC TEXT' not in repr(outcome)
