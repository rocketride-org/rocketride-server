# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Review regressions: ambiguous execution and complete parallel batches (#3494)."""

import json

import pytest

from ai.common.agent._internal import protocol

from .test_protocol import scripted

CALLS = [
    {'type': 'tool_call', 'name': 'crm.get', 'args': {'id': 1}},
    {'type': 'tool_call', 'name': 'crm.list', 'args': {}},
]
BATCH = json.dumps({'type': 'tool_calls', 'calls': CALLS})
ARRAY = json.dumps(CALLS)


@pytest.mark.parametrize('parallel', [False, True])
@pytest.mark.parametrize('newline', ['\n', '\r', '\r\n'])
@pytest.mark.parametrize('call', [json.dumps(CALLS[0]), BATCH])
def test_a_call_cancelled_by_later_prose_does_not_run(parallel, newline, call):
    raw = newline.join(['I could run', call, 'but it is not needed.', 'FINAL>>> Nothing to do.'])
    ask, feedback = scripted(raw)
    assert protocol.parse_reply(raw, allow_parallel=parallel) is None
    with pytest.raises(ValueError, match='after 3 attempts'):
        protocol.run_model_turn(ask, allow_parallel=parallel)
    assert len(feedback) == 3
    assert 'surrounding prose' in feedback[1]
    ask, feedback = scripted(raw, 'FINAL>>> Nothing to do.')
    answer = protocol.run_model_turn(ask, allow_parallel=parallel)
    assert answer.content == 'Nothing to do.'
    assert answer.tool_calls == []
    assert len(feedback) == 2


@pytest.mark.parametrize('pretty', [False, True])
@pytest.mark.parametrize('wrapper', ['{}', '```json\n{}\n```', 'Here are the calls: {}', '{}\nFINAL>>> Done.'])
def test_call_arrays_run_all_entries_only_with_parallel_support(wrapper, pretty):
    raw = wrapper.format(json.dumps(CALLS, indent=2) if pretty else ARRAY)
    answer = protocol.parse_reply(raw, allow_parallel=True)
    assert [(call['name'], call['args']) for call in answer.tool_calls] == [('crm.get', {'id': 1}), ('crm.list', {})]
    assert len({call['id'] for call in answer.tool_calls}) == 2
    ask, feedback = scripted(raw)
    with pytest.raises(ValueError, match='after 3 attempts'):
        protocol.run_model_turn(ask)
    assert len(feedback) == 3
    assert 'one tool call per reply' in feedback[1]


@pytest.mark.parametrize(
    'bad',
    [
        None,
        'bad',
        {},
        {'args': {'id': 2}},
        {'name': ''},
        {'name': None},
        {'name': 2},
        {'type': 'final', 'name': 'crm.get'},
    ],
)
@pytest.mark.parametrize('array', [False, True])
@pytest.mark.parametrize('index', [0, 1, 2])
def test_invalid_batches_are_retried_atomically_with_the_bad_index(bad, array, index):
    entries = CALLS.copy()
    entries.insert(index, bad)
    raw = json.dumps(entries if array else {'type': 'tool_calls', 'calls': entries})
    assert protocol.parse_reply(raw, allow_parallel=True) is None
    ask, feedback = scripted(raw)
    with pytest.raises(ValueError, match='after 3 attempts'):
        protocol.run_model_turn(ask, allow_parallel=True)
    assert len(feedback) == 3
    assert f'index {index}' in feedback[1]
    ask, feedback = scripted(raw, BATCH)
    repaired = protocol.run_model_turn(ask, allow_parallel=True)
    assert len(repaired.tool_calls) == 2
    assert len(feedback) == 2


@pytest.mark.parametrize('raw', ['[' + json.dumps(CALLS[0]) + ',', ARRAY[:-1]])
def test_a_truncated_array_never_dispatches_its_first_complete_call(raw):
    assert protocol.parse_reply(raw, allow_parallel=True) is None
    assert protocol.parse_reply(raw) is None


@pytest.mark.parametrize('calls', [BATCH, ARRAY])
def test_calls_after_a_marker_retry_with_both_parallel_shapes(calls):
    raw = 'FINAL>>> ' + calls
    assert protocol.parse_reply(raw, allow_parallel=True) is None
    ask, feedback = scripted(raw, BATCH)
    assert len(protocol.run_model_turn(ask, allow_parallel=True).tool_calls) == 2
    assert '"type":"tool_call"' in feedback[1]
    assert '"type":"tool_calls"' in feedback[1]
    assert 'without FINAL>>>' in feedback[1]


@pytest.mark.parametrize('tail', ['', '\nFINAL>>> Done.', '\n```'])
def test_combined_final_and_pending_call_is_diagnosed_before_extra_data(tail):
    raw = '{"type":"final","content":"Done."}\n' + json.dumps(CALLS[0]) + tail
    problem, _excerpt, remedy = protocol._diagnose(raw, allow_parallel=True)
    assert problem == 'combined a final answer with a pending tool call.'
    assert 'Generate the required tool call' in remedy
    assert 'do not answer in prose' in remedy
