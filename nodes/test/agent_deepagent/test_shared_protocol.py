# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Shared reply handling through the real DeepAgents async graph and AgentBase boundary."""

from __future__ import annotations

import json
import threading

import pytest

from .._real_langchain import DEEPAGENT_SYMBOLS, load_adapter, real_langchain_or_skip
from ..agent_langchain.test_final_envelope import ANSWERED, FAILED, GET_DEAL, QUESTION, _IInstance, _Run


@pytest.fixture(scope='module')
def adapter():
    restore = real_langchain_or_skip()
    try:
        pytest.importorskip('deepagents')
        module = load_adapter('agent_deepagent/deepagent.py', '_deepagent_shared_protocol', DEEPAGENT_SYMBOLS)
        if not hasattr(module.DeepAgentDriver, 'run_agent'):
            pytest.skip('the engine ai package is not importable')
        yield module
    finally:
        restore()


@pytest.fixture
def run(adapter):
    from ai.common.schema import Question

    def run_agent(*replies, tools=(), before_invoke=None):
        prompts = []

        def call_llm(context, prompt, **kwargs):
            prompts.append(prompt)
            return replies[min(len(prompts) - 1, len(replies) - 1)]

        driver = adapter.DeepAgentDriver.__new__(adapter.DeepAgentDriver)
        driver._instructions = []
        driver._agent_description = ''
        driver._system_prompt = ''
        driver._description = ''
        driver._require_tool_call = False
        driver.call_llm = call_llm
        question = Question()
        question.addQuestion(QUESTION)
        instance = _IInstance(tools)
        if before_invoke is not None:
            host_tools = instance._agent_host.tools
            invoke = host_tools.invoke

            def gated(tool_name, args):
                before_invoke()
                return invoke(tool_name, args)

            host_tools.invoke = gated
        return _Run(driver.run_agent(instance, question), prompts, instance)

    return run_agent


@pytest.mark.parametrize('case', ANSWERED)
def test_answer_reaches_the_caller_through_deepagents(run, case):
    raw, calls, answer = ANSWERED[case]
    result = run(raw)
    assert result.content == answer
    assert result.stop_reason is None
    assert result.written == [answer]
    assert len(result.prompts) == calls


@pytest.mark.parametrize('case', [case for case in FAILED if case != 'parallel_form_the_node_does_not_offer'])
def test_invalid_reply_fails_the_deepagent_run(run, case):
    raw, reason = FAILED[case]
    result = run(raw, tools=(GET_DEAL,))
    assert result.stop_reason == 'error'
    assert reason in result.content
    assert result.written == [result.content]
    assert result.invocations == []
    assert len(result.prompts) == 3
    assert result.payload['stack'][0]['kind'] == 'RocketRide.agent.error.v1'
    assert result.sse[-1][1]['stop_reason'] == 'error'


PARALLEL_CALLS = json.dumps(
    {
        'type': 'tool_calls',
        'calls': [
            {'name': 'crm.get_deal', 'args': {'deal_id': 41}},
            {'name': 'crm.get_deal', 'args': {'deal_id': 42}},
        ],
    }
)
BOTH_DEALS = [('crm.get_deal', {'deal_id': 41}), ('crm.get_deal', {'deal_id': 42})]


def by_deal(invocations):
    return sorted(invocations, key=lambda call: call[1]['deal_id'])


def test_parallel_tools_execute_and_feed_the_next_turn(run):
    # Each call waits for the other to start. Dispatched one after the other, the first would wait alone,
    # the barrier would break, and the tool would fail instead of answering.
    both_started = threading.Barrier(2, timeout=10)
    result = run(
        json.dumps(
            {
                'type': 'tool_calls',
                'calls': [
                    {'name': 'crm.get_deal', 'args': {'deal_id': 41}},
                    {'name': 'crm.get_deal', 'args': {'deal_id': 42}},
                ],
            }
        ),
        'FINAL>>> Both deals are won.',
        tools=(GET_DEAL,),
        before_invoke=both_started.wait,
    )
    assert by_deal(result.invocations) == BOTH_DEALS
    assert not both_started.broken
    assert result.content == 'Both deals are won.'
    assert result.stop_reason is None
    assert result.payload['meta']['tool_calls'] == 2
    assert len(result.prompts) == 2
    # Both results reach the next turn, not only one of them.
    assert '"deal_id": 41' in result.prompts[1]
    assert '"deal_id": 42' in result.prompts[1]
    assert '"stage": "won"' in result.prompts[1]
    assert 'system: Parallel tool calls' in result.prompts[0]


def test_a_quoted_tool_call_does_not_run_again(run):
    result = run(
        'Previously: {"type":"tool_call","name":"crm.get_deal","args":{"deal_id":42}} returned won.\n'
        'FINAL>>> Deal 42 is won.',
        tools=(GET_DEAL,),
    )
    assert result.invocations == []
    assert result.content == 'Deal 42 is won.'
    assert result.stop_reason is None
    assert len(result.prompts) == 1


def test_a_claim_stacked_onto_parallel_calls_is_not_delivered(run):
    """Both calls run, and the answer comes from the turn after them, not from the line the model stacked on."""
    result = run(PARALLEL_CALLS + '\nFINAL>>> Both deals are won.', 'FINAL>>> Looked up.', tools=(GET_DEAL,))
    assert by_deal(result.invocations) == BOTH_DEALS
    assert result.content == 'Looked up.'
    assert result.stop_reason is None
    assert len(result.prompts) == 2


def test_of_two_tool_calls_sent_as_an_array_only_the_first_runs(run):
    """The first JSON object is the envelope, as in agent_langchain. Several calls belong in one tool_calls envelope."""
    first = '{"type":"tool_call","name":"crm.get_deal","args":{"deal_id":41}}'
    second = '{"type":"tool_call","name":"crm.get_deal","args":{"deal_id":42}}'
    result = run('[' + first + ',' + second + ']', 'FINAL>>> Deal 41 is won.', tools=(GET_DEAL,))
    assert result.invocations == [('crm.get_deal', {'deal_id': 41})]
    assert result.content == 'Deal 41 is won.'
    assert result.stop_reason is None
    assert len(result.prompts) == 2


def test_a_sub_agent_turn_with_no_reply_fails_the_run(run):
    """
    The orchestrator delegates, and the sub-agent's model says nothing three times. An empty reply is not an
    answer in a sub-agent either: the turn raises, and the orchestrator's run ends as an error.
    """
    delegated = 'Look up the fiscal year of the filing.'
    result = run(
        '{"type":"tool_call","name":"task","args":{"description":"'
        + delegated
        + '","subagent_type":"general-purpose"}}',
        '',
        '',
        '',
        'FINAL>>> The sub-agent returned nothing.',
    )
    assert result.stop_reason == 'error'
    assert 'The last reply was empty.' in result.content
    assert len(result.prompts) == 4
    # The three empty replies went to the sub-agent: its prompt carries the delegated task and not the
    # orchestrator's question. Had the orchestrator received them, this would pass for the wrong reason.
    assert QUESTION in result.prompts[0]
    for prompt in result.prompts[1:]:
        assert delegated in prompt
        assert QUESTION not in prompt


@pytest.mark.parametrize(
    'raw',
    [
        'FINAL>>>\n' + PARALLEL_CALLS,
        '{"type":"final","content":"Both sent."}\n' + PARALLEL_CALLS,
    ],
)
def test_misplaced_parallel_calls_retry_before_any_work_runs(run, raw):
    failed = run(raw, tools=(GET_DEAL,))
    assert failed.invocations == []
    assert failed.stop_reason == 'error'
    assert len(failed.prompts) == 3

    repaired = run(raw, PARALLEL_CALLS, 'FINAL>>> Both checked.', tools=(GET_DEAL,))
    assert by_deal(repaired.invocations) == BOTH_DEALS
    assert repaired.content == 'Both checked.'
    assert repaired.stop_reason is None
    assert len(repaired.prompts) == 3


def test_a_parallel_call_after_a_preamble_object_runs_once(run):
    result = run('Example: {"x":1}\n' + PARALLEL_CALLS, 'FINAL>>> Both checked.', tools=(GET_DEAL,))
    assert by_deal(result.invocations) == BOTH_DEALS
    assert result.content == 'Both checked.'
    assert result.stop_reason is None
    assert len(result.prompts) == 2
