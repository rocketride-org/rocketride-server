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
@pytest.mark.parametrize('wrapper', ['{}', 'Here are the calls: {}', '```json\n{}\n```'])
def test_a_truncated_array_never_dispatches_its_first_complete_call(raw, wrapper):
    raw = wrapper.format(raw)
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


@pytest.mark.parametrize('parallel', [False, True])
@pytest.mark.parametrize('wrapper', ['{}', '```json\n{}\n```'])
@pytest.mark.parametrize('kind', ['tool_call', 'tool_calls'])
@pytest.mark.parametrize('opening', ['{"type":', '{"type" ', '{type:', '{\n// call\n"type":'])
def test_a_broken_call_after_the_marker_retries_instead_of_becoming_an_answer(parallel, wrapper, kind, opening):
    broken = '{"type":"tool_call","name":"crm.create","args":{"note":"a "quoted" word"}}'
    if kind == 'tool_calls':
        broken = '{"type":"tool_calls","calls":[' + broken + ']}'
    broken = broken.replace('{"type":', opening, 1)
    raw = 'FINAL>>> ' + wrapper.format(broken)
    assert protocol.parse_reply(raw, allow_parallel=parallel) is None
    ask, feedback = scripted(raw)
    with pytest.raises(ValueError, match='after 3 attempts'):
        protocol.run_model_turn(ask, allow_parallel=parallel)
    assert len(feedback) == 3
    ask, feedback = scripted(raw, json.dumps(CALLS[0]))
    result = protocol.run_model_turn(ask, allow_parallel=parallel)
    assert [call['name'] for call in result.tool_calls] == ['crm.get']
    assert len(feedback) == 2
    assert 'without FINAL>>>' in feedback[1]
    quoted = 'The malformed example is ' + broken + ' and needs escaping.'
    assert protocol.parse_reply('FINAL>>> ' + quoted).content == quoted


@pytest.mark.parametrize('wrapper', ['{}', '```json\n{}\n```', '[{}]', 'FINAL>>> {}', '{}\nFINAL>>>'])
@pytest.mark.parametrize('value', ['1e400', '-1e400', 'NaN', 'Infinity', '-Infinity'])
@pytest.mark.parametrize('content', ['{}', '{{"estimate":{}}}', '[{}]'])
def test_non_finite_final_content_retries_without_emitting_invalid_json(wrapper, value, content):
    raw = wrapper.format('{"type":"final","content":' + content.format(value) + '}')
    assert protocol.parse_reply(raw) is None
    ask, feedback = scripted(raw)
    with pytest.raises(ValueError, match='after 3 attempts'):
        protocol.run_model_turn(ask)
    assert len(feedback) == 3
    assert 'finite JSON numbers' in feedback[1]
    ask, feedback = scripted(raw, '{"type":"final","content":{"estimate":1e300}}')
    result = protocol.run_model_turn(ask)
    assert json.loads(result.content) == {'estimate': 1e300}
    assert len(feedback) == 2


@pytest.mark.parametrize('parallel', [False, True])
@pytest.mark.parametrize(
    'comment', ['// example wrapper', '/* example wrapper */', '// } closes only the comment', '/* { [ ] } */']
)
def test_comments_cannot_authorize_calls_nested_in_an_object_wrapper(parallel, comment):
    raw = '{\n  ' + comment + '\n  ' + json.dumps(CALLS[0]) + '\n}'
    assert protocol.parse_reply(raw, allow_parallel=parallel) is None
    ask, feedback = scripted(raw)
    with pytest.raises(ValueError, match='after 3 attempts'):
        protocol.run_model_turn(ask, allow_parallel=parallel)
    assert len(feedback) == 3
    # A closed ordinary object does not hide a later, independent call.
    result = protocol.parse_reply('Example: {"x":1}\n' + json.dumps(CALLS[0]), allow_parallel=parallel)
    assert [call['name'] for call in result.tool_calls] == ['crm.get']


@pytest.mark.parametrize('parallel', [False, True])
@pytest.mark.parametrize('tail', ['', '\n' + json.dumps(CALLS[0]), '\nFINAL>>> Claimed.'])
def test_a_broken_envelope_after_a_valid_final_does_not_hide_pending_work(parallel, tail):
    first = '{"type":"final","content":"Done."}'
    broken = '{"type":"final","content":"bad "quote" here"}'
    raw = first + '\n' + broken + tail
    assert protocol.parse_reply(raw, allow_parallel=parallel) is None
    ask, feedback = scripted(raw)
    with pytest.raises(ValueError, match='after 3 attempts'):
        protocol.run_model_turn(ask, allow_parallel=parallel)
    assert len(feedback) == 3
    quoted = first + '\n```json\n' + broken + '\n' + json.dumps(CALLS[0]) + '\n```'
    assert protocol.parse_reply(quoted, allow_parallel=parallel).content == 'Done.'


@pytest.mark.parametrize(
    'prefix',
    ['Note [1].\n', 'Example: {"x":1}\n', 'Note [1] and [2].\n', 'See https://example.test: ', '[{"x":1}]\n'],
)
@pytest.mark.parametrize('parallel', [False, True])
def test_a_preamble_cannot_bypass_complete_call_array_validation(prefix, parallel):
    raw = prefix + json.dumps([CALLS[0], {'args': {}}])
    assert protocol.parse_reply(raw, allow_parallel=parallel) is None
    ask, feedback = scripted(raw)
    with pytest.raises(ValueError, match='after 3 attempts'):
        protocol.run_model_turn(ask, allow_parallel=parallel)
    assert len(feedback) == 3
    result = protocol.parse_reply(prefix + ARRAY, allow_parallel=parallel)
    if parallel:
        assert [call['name'] for call in result.tool_calls] == ['crm.get', 'crm.list']
    else:
        assert result is None
    single = protocol.parse_reply(prefix + json.dumps([CALLS[0]]), allow_parallel=parallel)
    assert [call['name'] for call in single.tool_calls] == ['crm.get']
    assert protocol.parse_reply(prefix + ARRAY[:-1], allow_parallel=parallel) is None
