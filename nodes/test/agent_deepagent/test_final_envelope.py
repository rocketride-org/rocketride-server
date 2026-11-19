# =============================================================================
# RocketRide Engine
# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""The DeepAgent adapter turns one model turn into a LangChain message, or fails the run.

The bug this file was written for: a chat answer reached the user as the raw protocol envelope,
``{"type":"final","content":"Here's what I found: ...``, because the content quoted a name and the
inner quotes were not escaped. The fixes (the ``FINAL>>>`` sentinel, salvage of a broken `final`
envelope, a retry hint that names the break) now live in ``ai.common.agent._internal.protocol``,
shared with ``agent_langchain`` (#3367), and are tested case by case in
``packages/ai/tests/ai/common/agent/test_protocol.py``.

What is checked here is this node's side of it, against the real ``langchain_core``: the adapter
offers and accepts parallel tool calls, builds a real ``AIMessage`` from the turn, and raises when
the retries end with nothing to deliver.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any, List, Tuple

import pytest

from .._real_langchain import DEEPAGENT_SYMBOLS, load_adapter, real_langchain_or_skip

# The payload that shipped the bug, trimmed to the break.
BROKEN_FINAL = (
    '{"type":"final","content":"Here\'s what I found:\\n\\n'
    '| Contact | Person in Pipedrive? |\\n'
    '| Richard Vasquez | **Not found**; no org named "EARTH" found |\\n\\n'
    'Would you like me to create person records?"}'
)
BROKEN_TOOL_CALL = '{"type":"tool_call","name":"crm.note_create","args":{"content":"a "quoted" note"}}'
REPAIRED_TOOL_CALL = '{"type":"tool_call","name":"crm.note_create","args":{"content":"a \\"quoted\\" note"}}'
PARALLEL_CALLS = '{"type":"tool_calls","calls":[{"name":"a.one","args":{}},{"name":"b.two","args":{"x":1}}]}'
ANSWER_JSON = '{"company": "Acme", "revenue": 1200}'


@pytest.fixture(scope='module')
def real_langchain():
    restore = real_langchain_or_skip()
    yield
    restore()


@pytest.fixture(scope='module')
def adapter(real_langchain):
    module = load_adapter('agent_deepagent/deepagent.py', '_agent_deepagent_final_envelope', DEEPAGENT_SYMBOLS)
    if module.run_model_turn.__module__ != 'ai.common.agent._internal.protocol':
        pytest.skip('the engine ai package is not importable')
    return module


@pytest.fixture
def model_answering(adapter):
    """Build the adapter's chat model around a host LLM that sends `replies` in order (the last one repeats)."""

    def build(*replies: str) -> Tuple[Any, List[str]]:
        prompts: List[str] = []

        def call_llm(context: Any, prompt: str, **kwargs: Any) -> str:
            prompts.append(prompt)
            return replies[min(len(prompts) - 1, len(replies) - 1)]

        return adapter._build_deepagent_llm(SimpleNamespace(call_llm=call_llm), SimpleNamespace()), prompts

    return build


def test_the_model_is_offered_parallel_tool_calls_and_the_sentinel(model_answering):
    model, prompts = model_answering('FINAL>>>ok')

    model.invoke('Read deal 42.')

    assert '{"type":"tool_calls","calls":[' in prompts[0]
    assert 'To ANSWER THE PERSON, do NOT use JSON. Write FINAL>>> and then your answer.' in prompts[0]


def test_a_sentinel_answer_is_the_message_content(model_answering):
    model, prompts = model_answering('FINAL>>>Here is a table with "EARTH" in it, and {braces}.')

    message = model.invoke('Find EARTH.')

    assert message.content == 'Here is a table with "EARTH" in it, and {braces}.'
    assert message.tool_calls == []
    assert len(prompts) == 1


def test_parallel_tool_calls_are_one_message_with_several_calls(model_answering):
    """The form that lets LangGraph fan out sub-agents in one turn."""
    model, _ = model_answering(PARALLEL_CALLS)

    message = model.invoke('Do both.')

    assert message.content == ''
    assert [(call['name'], call['args']) for call in message.tool_calls] == [('a.one', {}), ('b.two', {'x': 1})]


def test_a_final_line_stacked_onto_tool_calls_does_not_replace_them(model_answering):
    """Reading the sentinel first would drop the calls and deliver a sentence claiming the work was done."""
    model, _ = model_answering(PARALLEL_CALLS + '\nFINAL>>> Both are done.')

    message = model.invoke('Do both.')

    assert message.content == ''
    assert [call['name'] for call in message.tool_calls] == ['a.one', 'b.two']


def test_the_envelope_that_shipped_the_bug_is_salvaged_in_one_call(model_answering):
    model, prompts = model_answering(BROKEN_FINAL)

    message = model.invoke('Check the contacts.')

    assert message.content.startswith("Here's what I found:")
    assert 'no org named "EARTH" found' in message.content
    assert len(prompts) == 1


def test_a_final_whose_content_is_an_object_is_delivered_as_json(model_answering):
    """It used to arrive as Python's repr of the dict."""
    model, _ = model_answering('{"type":"final","content":' + ANSWER_JSON + '}')

    assert model.invoke('Extract.').content == ANSWER_JSON


def test_the_second_attempt_can_follow_the_first_hint(model_answering):
    """A broken tool call, the hint, the same call repaired: the turn ends in the call, in two LLM calls."""
    model, prompts = model_answering(BROKEN_TOOL_CALL, REPAIRED_TOOL_CALL)

    message = model.invoke('Leave a note.')

    assert message.tool_calls[0]['name'] == 'crm.note_create'
    assert message.tool_calls[0]['args'] == {'content': 'a "quoted" note'}
    assert len(prompts) == 2
    # The second prompt is the first plus the hint, and the hint asks for the call again.
    hint = prompts[1][len(prompts[0]) :]
    assert hint.startswith('\n\nsystem: Your last output was not valid JSON')
    assert 'do not answer in prose' in hint
    assert 'FINAL>>>' not in hint


@pytest.mark.parametrize(
    'reply',
    [
        BROKEN_TOOL_CALL,
        # A bare object may be a tool call that lost its "type".
        ANSWER_JSON,
        # Cut off mid-answer: this used to be delivered as a finished answer.
        '{"type":"final","content":"Acme reported revenue of 12',
        # These three used to be delivered too: nothing, the marker alone, and a broken call after a line of prose.
        '',
        'FINAL>>>',
        'Sure, let me do that.\n' + BROKEN_TOOL_CALL,
    ],
)
def test_a_turn_with_nothing_to_deliver_fails_the_run(model_answering, reply):
    """The tool never ran, or there is no answer: the person must not read the envelope as if it were one."""
    model, prompts = model_answering(reply)

    with pytest.raises(ValueError, match='No valid tool call or final answer after 3 attempts'):
        model.invoke('Leave a note.')
    assert len(prompts) == 3


def test_prose_that_skipped_the_sentinel_is_still_the_answer(model_answering):
    model, prompts = model_answering('I could not find that organization.')

    assert model.invoke('Find EARTH.').content == 'I could not find that organization.'
    assert len(prompts) == 3


def test_the_async_path_gives_the_same_message(model_answering):
    """LangGraph drives the deep agent through ``_agenerate``, which runs the same turn off the event loop."""
    model, prompts = model_answering(BROKEN_TOOL_CALL, PARALLEL_CALLS)

    message = asyncio.run(model.ainvoke('Do both.'))

    assert [call['name'] for call in message.tool_calls] == ['a.one', 'b.two']
    assert len(prompts) == 2
