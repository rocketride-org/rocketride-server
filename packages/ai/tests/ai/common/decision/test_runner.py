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
"""Unit tests for ai.common.decision.runner (fake client, no HTTP)."""

import pytest

from ai.common.decision.client import SystemOneError
from ai.common.decision.limits import DecisionLimits
from ai.common.decision.questions import PICK_ONE, YES_NO, QuestionSpec
from ai.common.decision.runner import DecisionRunner, merge_decisions

LIM = DecisionLimits(max_options=26, max_levels=10, max_questions=64, max_state_tokens=1000, chars_per_token=4.0)
SPECS = [
    QuestionSpec('urgent', YES_NO, 'Urgent?'),
    QuestionSpec('team', PICK_ONE, 'Team?', options=(('billing', None), ('bug', None))),
]
REPLY = {
    'model': 'jev-1.13.0',
    'answers': {
        'urgent': {'type': 'noul', 'noul': 0.9},
        'team': {'type': 'choice', 'choice': 'bug', 'probabilities': {'billing': 0.2, 'bug': 0.8}, 'confidence': 0.6},
    },
    'usage': {'input_tokens': 100, 'output_tokens': 2},
}


class FakeClient:
    def __init__(self, *replies):
        self.replies = list(replies)
        self.calls = []

    def decide(self, model, state, questions):
        self.calls.append({'model': model, 'state': state, 'questions': questions})
        reply = self.replies.pop(0)
        if isinstance(reply, Exception):
            raise reply
        return reply


def _runner(client, **kw):
    warnings = []
    return DecisionRunner(client, 'jev-latest', SPECS, kw.pop('limits', LIM), warn=warnings.append, **kw), warnings


def test_one_call_for_all_questions():
    client = FakeClient(REPLY)
    runner, _ = _runner(client)
    result = runner.decide('My payouts fail', {'parent': 'a.txt'}, source='n1')
    assert len(client.calls) == 1
    assert set(client.calls[0]['questions']) == {'urgent', 'team'}
    assert client.calls[0]['state'] == 'My payouts fail'
    assert result.decisions['urgent']['answer'] == 'yes'
    assert result.decisions['team']['answer'] == 'bug' and result.decisions['team']['source'] == 'n1'
    assert result.usage == {'input_tokens': 100, 'output_tokens': 2} and result.truncated is False


def test_state_metadata_builds_object_state_skipping_missing():
    client = FakeClient(REPLY)
    runner, _ = _runner(client, state_metadata=('parent', 'nope'))
    runner.decide('body', {'parent': 'a.txt'}, source='n')
    assert client.calls[0]['state'] == {'content': 'body', 'parent': 'a.txt'}


def test_empty_content_skips_call_and_warns():
    client = FakeClient()
    runner, warnings = _runner(client)
    result = runner.decide('   ', None, source='n')
    assert client.calls == [] and result.skipped is True and result.decisions == {}
    assert any('empty' in w for w in warnings)


def test_oversize_truncates_head_and_warns():
    client = FakeClient(REPLY)
    runner, warnings = _runner(client, limits=DecisionLimits(26, 10, 64, max_state_tokens=400, chars_per_token=4.0))
    result = runner.decide('HEAD' + 'x' * 10_000, None, source='n')
    sent = client.calls[0]['state']
    assert sent.startswith('HEAD') and len(sent) < 10_000
    assert result.truncated is True and any('truncated' in w for w in warnings)


def test_too_large_retries_once_with_shrunk_content():
    client = FakeClient(SystemOneError('too_large', 'big', status=413), REPLY)
    runner, _ = _runner(client)
    result = runner.decide('y' * 1000, None, source='n')
    assert len(client.calls) == 2
    assert len(client.calls[1]['state']) == int(len(client.calls[0]['state']) * 0.75)
    assert result.truncated is True and result.decisions['urgent']['answer'] == 'yes'


def test_fail_mode_raises():
    runner, _ = _runner(FakeClient(SystemOneError('server', 'down', status=503)), on_error='fail')
    with pytest.raises(SystemOneError):
        runner.decide('text', None, source='n')


def test_pass_through_mode_returns_error_decisions():
    runner, _ = _runner(FakeClient(SystemOneError('server', 'down', status=503)), on_error='pass_through')
    result = runner.decide('text', None, source='n')
    assert {d['answer'] for d in result.decisions.values()} == {'error'}
    assert result.decisions['team']['error'] == 'down'


def test_missing_answer_is_protocol_error_under_on_error():
    reply = {**REPLY, 'answers': {'urgent': REPLY['answers']['urgent']}}
    runner, _ = _runner(FakeClient(reply), on_error='pass_through')
    assert runner.decide('t', None, source='n').decisions['team']['answer'] == 'error'
    runner, _ = _runner(FakeClient(reply), on_error='fail')
    with pytest.raises(SystemOneError) as exc:
        runner.decide('t', None, source='n')
    assert exc.value.kind == 'protocol'


def test_merge_keeps_other_names_and_warns_on_overwrite():
    warnings = []
    existing = {'a': {'answer': 'yes', 'source': 'first'}, 'b': {'answer': 'no', 'source': 'first'}}
    merged = merge_decisions(existing, {'b': {'answer': 'yes', 'source': 'second'}}, warn=warnings.append)
    assert merged['a']['source'] == 'first' and merged['b']['source'] == 'second'
    assert len(warnings) == 1 and 'first' in warnings[0]
    assert existing['b']['source'] == 'first'  # input not mutated


def test_merge_from_none():
    assert merge_decisions(None, {'a': {}}, warn=lambda _m: None) == {'a': {}}


def test_debug_logs_model_and_questions_and_request_id():
    """R3: debug kwarg logs model, question count, input tokens, latency, and request_id."""
    client = FakeClient(REPLY)
    client.last_request_id = 'req-12345'
    debug_logs = []
    runner, _ = _runner(client, debug=debug_logs.append)
    runner.decide('My payouts fail', {'parent': 'a.txt'}, source='n1')
    assert len(debug_logs) == 1
    debug_line = debug_logs[0]
    assert 'questions=2' in debug_line
    assert 'input_tokens=100' in debug_line
    assert 'model=jev-1.13.0' in debug_line
    assert 'req-12345' in debug_line


@pytest.mark.parametrize('error_kind', ['auth', 'not_found'])
def test_config_errors_always_fail_even_with_pass_through(error_kind):
    """R13: configuration errors (auth, not_found) always fail regardless of on_error mode."""
    runner, _ = _runner(
        FakeClient(SystemOneError(error_kind, f'{error_kind} error', status=401 if error_kind == 'auth' else 404)),
        on_error='pass_through',
    )
    with pytest.raises(SystemOneError) as exc:
        runner.decide('text', None, source='n')
    assert exc.value.kind == error_kind


@pytest.mark.parametrize('bad_reply', [[], 'x', {'answers': []}, {'answers': 'u'}])
def test_malformed_reply_envelope_honours_on_error(bad_reply):
    """A reply that is not a dict, or whose answers are not a dict, is a protocol error (not a crash)."""
    runner, warnings = _runner(FakeClient(bad_reply), on_error='pass_through')
    result = runner.decide('text', None, source='n')
    assert {d['answer'] for d in result.decisions.values()} == {'error'}
    assert result.usage is None and any('protocol' in w for w in warnings)
    runner, _ = _runner(FakeClient(bad_reply), on_error='fail')
    with pytest.raises(SystemOneError) as exc:
        runner.decide('text', None, source='n')
    assert exc.value.kind == 'protocol'


def test_non_dict_usage_is_treated_as_none():
    runner, _ = _runner(FakeClient({**REPLY, 'usage': 'lots'}))
    result = runner.decide('text', None, source='n')
    assert result.usage is None and result.decisions['urgent']['answer'] == 'yes'


def test_truncation_warning_cites_byte_limit_when_bytes_bind():
    limits = DecisionLimits(26, 10, 64, max_state_tokens=100_000, chars_per_token=4.0, max_body_bytes=700)
    runner, warnings = _runner(FakeClient(REPLY), limits=limits)
    result = runner.decide('x' * 5000, None, source='n')
    assert result.truncated is True
    assert any('truncated' in w and 'bytes' in w and 'tokens' not in w for w in warnings)


def test_truncation_warning_cites_token_limit_when_tokens_bind():
    runner, warnings = _runner(
        FakeClient(REPLY), limits=DecisionLimits(26, 10, 64, max_state_tokens=400, chars_per_token=4.0)
    )
    runner.decide('x' * 10_000, None, source='n')
    assert any('truncated' in w and 'tokens' in w for w in warnings)


def test_backend_body_goes_to_debug_never_to_warn():
    error = SystemOneError('invalid', '422 from http://x/v1/systemone', status=422, body='SECRET-DOC-TEXT')
    debug_logs = []
    runner, warnings = _runner(FakeClient(error), on_error='pass_through', debug=debug_logs.append)
    result = runner.decide('text', None, source='n')
    assert any('SECRET-DOC-TEXT' in line for line in debug_logs)
    assert not any('SECRET-DOC-TEXT' in w for w in warnings)
    assert 'SECRET-DOC-TEXT' not in result.decisions['urgent']['error']
