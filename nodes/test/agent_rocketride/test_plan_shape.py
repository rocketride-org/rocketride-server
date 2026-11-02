# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Tests for ``normalize_plan``, which checks every planning reply before the loop acts on it.

The loop used to trust the reply as sent, so ordinary format slips changed what
happened. ``"done": "false"`` finished the run, because a non-empty string is truthy.
A call written as plain text crashed it, and OpenAI's call shape failed as "Tool not
found". These tests call ``normalize_plan`` directly, one reply shape at a time, and
pin each repair and each problem it reports. The ``wave`` fixture in conftest.py
loads the planner from source.
"""

from __future__ import annotations

import pytest


@pytest.fixture
def check(wave):
    """normalize_plan from the node's source."""
    return wave.planner.normalize_plan


@pytest.mark.parametrize(
    ('raw', 'done'),
    [(True, True), ('true', True), (' TRUE ', True), (False, False), ('false', False), ('False', False), (1, False)],
)
def test_done_counts_by_meaning(check, raw, done):
    plan, _ = check({'done': raw, 'answer': 'ok'})

    assert plan['done'] is done


def test_wave_shape_passes_through(check):
    plan, problems = check({'tool_calls': [{'tool': 'workspace.read', 'args': {'path': 'a'}}]})

    assert plan['tool_calls'] == [{'tool': 'workspace.read', 'args': {'path': 'a'}}]
    assert problems == []


@pytest.mark.parametrize(
    'entry',
    [
        {'name': 'workspace.read', 'arguments': '{"path": "a"}'},
        {'type': 'function', 'function': {'name': 'workspace.read', 'arguments': '{"path": "a"}'}},
        {'name': 'workspace.read', 'arguments': {'path': 'a'}},
        {'name': 'workspace.read', 'args': None, 'arguments': '{"path": "a"}'},
        {'tool': 'workspace.read', 'args': None, 'function': {'name': 'workspace.read', 'arguments': {'path': 'a'}}},
    ],
    ids=['openai-flat', 'openai-nested', 'arguments-as-object', 'null-args-flat', 'null-args-nested'],
)
def test_openai_call_shapes_are_read(check, entry):
    plan, problems = check({'tool_calls': [entry]})

    assert plan['tool_calls'] == [{'tool': 'workspace.read', 'args': {'path': 'a'}}]
    assert problems == []


def test_missing_args_mean_no_args(check):
    plan, problems = check({'tool_calls': [{'tool': 'workspace.list'}]})

    assert plan['tool_calls'] == [{'tool': 'workspace.list', 'args': {}}]
    assert problems == []


def test_a_single_call_outside_a_list_is_wrapped(check):
    plan, _ = check({'tool_calls': {'tool': 'workspace.list', 'args': {}}})

    assert plan['tool_calls'] == [{'tool': 'workspace.list', 'args': {}}]


@pytest.mark.parametrize(
    ('entry', 'problem'),
    [
        ('workspace.read src/App.css', 'tool_calls[0] was not an object'),
        ({'tool': 'workspace.read', 'args': '{not json'}, 'tool_calls[0] arguments were not valid JSON'),
        ({'tool': 'workspace.read', 'args': ['a']}, 'tool_calls[0] args were not an object'),
        ({'args': {'path': 'a'}}, 'tool_calls[0] named no tool'),
    ],
    ids=['text', 'bad-json-args', 'list-args', 'no-name'],
)
def test_a_bad_call_is_dropped_and_reported(check, entry, problem):
    good = {'tool': 'workspace.list', 'args': {}}
    plan, problems = check({'tool_calls': [entry, good]})

    assert plan['tool_calls'] == [good]
    assert problems == [problem]


@pytest.mark.parametrize(
    ('raw', 'problem'),
    [
        ({}, 'tool_calls[0] named no tool'),
        ('', 'tool_calls was not a list'),
        ('workspace.write src/App.tsx', 'tool_calls was not a list'),
    ],
    ids=['empty-object', 'empty-text', 'text'],
)
def test_an_empty_or_odd_tool_calls_value_cannot_vanish(check, raw, problem):
    """The work in a done reply like this did not happen, so its answer cannot stand."""
    plan, problems = check({'done': True, 'answer': 'Renamed the button.', 'tool_calls': raw})

    assert plan['done'] is False
    assert plan['tool_calls'] == []
    assert problems == [problem]


def test_remove_as_one_key_is_wrapped(check):
    plan, problems = check({'done': True, 'answer': 'ok', 'remove': 'wave-0.r0'})

    assert plan['remove'] == ['wave-0.r0']
    assert problems == []


def test_remove_entries_that_are_not_keys_are_dropped_and_reported(check):
    plan, problems = check({'done': True, 'answer': 'ok', 'remove': ['wave-0.r0', 3]})

    assert plan['remove'] == ['wave-0.r0']
    assert problems == ['remove[1] was not a key, so it was ignored']
    assert plan['done'] is True, 'remove only tidies memory, so it never blocks a finished reply'


def test_a_bad_remove_does_not_hide_a_reply_with_nothing_to_do(check):
    """A reply with no calls and no answer. The model must hear that, not only about its remove."""
    plan, problems = check({'thought': 't', 'tool_calls': [], 'remove': ''})

    assert problems == ['remove[0] was not a key, so it was ignored', 'it had neither done=true nor any tool_calls']


def test_blank_remove_keys_are_dropped_and_reported(check):
    """A blank key would reach the memory node as "clear everything"."""
    plan, problems = check({'tool_calls': [{'tool': 'workspace.list'}], 'remove': ['', '  ', 'wave-0.r0']})

    assert plan['remove'] == ['wave-0.r0']
    assert problems == ['remove[0] was not a key, so it was ignored', 'remove[1] was not a key, so it was ignored']


@pytest.mark.parametrize(
    'remove', [{'key': 'wave-0.r0'}, {}, False, 0], ids=['object', 'empty-object', 'false', 'zero']
)
def test_remove_that_is_not_a_list_is_reported(check, remove):
    plan, problems = check({'tool_calls': [{'tool': 'workspace.list'}], 'remove': remove})

    assert plan['remove'] == []
    assert problems == ['remove was not a list of keys, so nothing was removed']


def test_done_without_an_answer_is_not_done(check):
    plan, problems = check({'done': True, 'answer': '  '})

    assert plan['done'] is False
    assert problems == ['it set done=true without an answer']


def test_done_with_calls_but_no_answer_runs_the_calls_and_goes_on(check):
    """With no answer to give, done=true cannot stand, but the calls still run."""
    plan, problems = check({'done': True, 'answer': ' ', 'tool_calls': [{'tool': 'workspace.list', 'args': {}}]})

    assert plan['done'] is False
    assert plan['tool_calls'] == [{'tool': 'workspace.list', 'args': {}}]
    assert problems == ['it set done=true without an answer']


def test_done_with_a_dropped_call_is_not_done(check):
    """The reply described work that did not all happen, so its answer cannot stand."""
    good = {'tool': 'workspace.list', 'args': {}}
    plan, problems = check({'done': True, 'answer': 'Renamed it.', 'tool_calls': ['workspace.write a', good]})

    assert plan['done'] is False
    assert plan['tool_calls'] == [good]
    assert problems == ['tool_calls[0] was not an object']


def test_done_with_calls_keeps_both_for_the_loop_to_order(check):
    """The planner keeps both. The loop runs the calls first and finishes only if they all worked."""
    plan, problems = check({'done': True, 'answer': 'ok', 'tool_calls': [{'tool': 'workspace.list', 'args': {}}]})

    assert plan['done'] is True
    assert len(plan['tool_calls']) == 1
    assert problems == []


def test_a_reply_with_nothing_to_do_says_so(check):
    plan, problems = check({'thought': 'thinking', 'scratch': ''})

    assert plan['done'] is False
    assert problems == ['it had neither done=true nor any tool_calls']


def test_a_reply_that_is_not_an_object_says_what_it_was(check):
    plan, problems = check(['workspace.list'])

    assert plan == {'done': False, 'asked_done': False, 'tool_calls': [], 'remove': []}
    assert problems == ['the reply was a JSON list, not an object']
