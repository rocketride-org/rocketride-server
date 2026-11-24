# =============================================================================
# RocketRide Engine
# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""A LangChain agent run ends in the model's answer or in an error, never in a sentence about giving up (#3367).

The adapter asks for every final answer as ``{"type":"final","content":"..."}`` and used to decode it
with no repair. An unescaped quote, a literal line break or an answer with no envelope failed all
three attempts, and the run then returned "The language model produced unparseable output after 3
attempts" as a normal answer, with no ``stop_reason``. The prompt is unchanged; what changed is how
a reply is read, retried and, when nothing can be delivered, failed.

Each case runs the real ``LangChainDriver`` through ``AgentBase.run_agent`` and the real
``langchain.agents.create_agent``. Only the host LLM is scripted, so what is checked is what a caller
gets: the answer payload, its ``stop_reason`` and the text written to the answers lane. The parser
and the retry loop have their own tests in ``packages/ai/tests/ai/common/agent/test_protocol.py``.
"""

from __future__ import annotations

import json
from typing import Any, Dict, List, Tuple

import pytest

from .._real_langchain import LANGCHAIN_SYMBOLS, load_adapter, real_langchain_or_skip

QUESTION = 'Extract the company name and revenue from this filing. Answer with JSON only.'
ANSWER_JSON = '{"company": "Acme", "revenue": 1200}'
GAVE_UP = 'unparseable output after 3 attempts'
BROKEN_TOOL_CALL = '{"type":"tool_call","name":"crm.get_deal","args":{"note":"a "quoted" word"}}'
PARALLEL_CALLS = '{"type":"tool_calls","calls":[{"name":"crm.get_deal","args":{"deal_id":1}},{"name":"crm.get_deal","args":{"deal_id":2}}]}'
GET_DEAL = {
    'name': 'crm.get_deal',
    'description': 'Get a single deal by id.',
    'inputSchema': {'type': 'object', 'required': ['deal_id'], 'properties': {'deal_id': {'type': 'integer'}}},
}

# The replies from the table in #3367, each sent on every attempt: (reply, model calls, answer delivered).
QUOTED_ANSWER_JSON = json.dumps({'company': 'Acme', 'quote': 'Its CEO called it a "record" year.'})
ANSWERED = {
    'A_json_answer_not_escaped_with_a_quoted_word_in_a_value': (
        '{"type":"final","content":"' + QUOTED_ANSWER_JSON + '"}',
        1,
        QUOTED_ANSWER_JSON,
    ),
    'A_json_answer_inner_quotes_not_escaped': ('{"type":"final","content":"' + ANSWER_JSON + '"}', 1, ANSWER_JSON),
    'B_json_answer_inner_quotes_escaped': (json.dumps({'type': 'final', 'content': ANSWER_JSON}), 1, ANSWER_JSON),
    'C_json_answer_as_an_object': ('{"type":"final","content":' + ANSWER_JSON + '}', 1, ANSWER_JSON),
    'E_prose_one_quoted_word_not_escaped': (
        '{"type":"final","content":"No org named "EARTH" was found."}',
        1,
        'No org named "EARTH" was found.',
    ),
    'F_prose_with_a_literal_line_break': (
        '{"type":"final","content":"Line one.\nLine two."}',
        1,
        'Line one.\nLine two.',
    ),
    'G_plain_prose_no_envelope': ('Acme reported revenue of 1200.', 3, 'Acme reported revenue of 1200.'),
    'H_raw_json_array_no_envelope': ('[' + ANSWER_JSON + ']', 3, '[' + ANSWER_JSON + ']'),
    'json_in_a_fence_inside_a_broken_final': (
        '{"type":"final","content":"```json\n{"company":"Acme","stage":"won"}\n```"}',
        1,
        '```json\n{"company":"Acme","stage":"won"}\n```',
    ),
    'code_block_before_the_sentinel': (
        'function run()\n{\n  return call({ args: { id: 1 } });\n}\nFINAL>>> Done.',
        1,
        'Done.',
    ),
    'code_that_names_a_name_and_arguments_before_the_sentinel': (
        'payload = {"name": "demo", "enabled": True}\nrequests.post(url, json={"args": payload})\n'
        'FINAL>>> That posts the job.',
        1,
        'That posts the job.',
    ),
    'prose_that_starts_with_a_brace': ('{curly} braces are used in sets.', 3, '{curly} braces are used in sets.'),
    'prose_that_names_a_type': (
        'Answer: set "type": "final" in config.',
        3,
        'Answer: set "type": "final" in config.',
    ),
    'json_answer_after_the_sentinel': ('FINAL>>>' + ANSWER_JSON, 1, ANSWER_JSON),
    'envelope_kept_after_the_sentinel': (
        'FINAL>>> ' + json.dumps({'type': 'final', 'content': ANSWER_JSON}),
        1,
        ANSWER_JSON,
    ),
    'final_wrapped_in_an_array': ('[' + json.dumps({'type': 'final', 'content': ANSWER_JSON}) + ']', 1, ANSWER_JSON),
    'final_with_a_fenced_tool_example': (
        '{"type":"final","content":"Here is how to call it."}\n```json\n'
        '{"type":"tool_call","name":"crm.get_deal","args":{"deal_id":1}}\n```',
        1,
        'Here is how to call it.',
    ),
    'code_with_a_first_typeless_dictionary': (
        'Use this helper:\n\ndef f():\n    return {"name": "x", "args": [1]}',
        3,
        'Use this helper:\n\ndef f():\n    return {"name": "x", "args": [1]}',
    ),
    'marker_after_a_bare_carriage_return': ('Thinking\rFINAL>>> ok', 1, 'ok'),
    'recovery_preserves_an_unpaired_unicode_escape': (
        '{"type":"final","content":"bad \\ud800 "x""}',
        1,
        'bad \\ud800 "x"',
    ),
}

# Replies with no answer to deliver: (reply, what the error says about it).
FAILED = {
    'D_raw_json_object_no_envelope': (ANSWER_JSON, 'not one of the allowed shapes'),
    'I_envelope_cut_off_mid_answer': ('{"type":"final","content":"Acme reported revenue of 12', 'not valid JSON'),
    'tool_call_that_never_parses': (BROKEN_TOOL_CALL, 'not valid JSON'),
    'parallel_form_the_node_does_not_offer': (PARALLEL_CALLS, 'not one of the allowed shapes'),
    'empty_reply': ('', 'The last reply was empty.'),
    'broken_tool_call_after_a_line_of_prose': ('Sure, let me do that.\n' + BROKEN_TOOL_CALL, 'not valid JSON'),
    'marker_with_no_answer': ('FINAL>>>', 'ended at FINAL>>> with no answer after it'),
    'claim_after_a_pretty_printed_broken_tool_call': (
        '{\n  "name": "crm.get_deal",\n  "args": {"note": "a "quoted" word"},\n  "type": "tool_call"\n}\n'
        'FINAL>>> Deal 42 is won.',
        'not valid JSON',
    ),
    'broken_final_with_text_after_it': (
        '{"type":"final","content":"No org named "EARTH" was found."} Hope that helps!',
        'not valid JSON',
    ),
    'tool_call_that_lost_its_type_after_a_line_of_prose': (
        'Here is the result:\n{"name":"crm.get_deal","args":{"deal_id":42}}',
        'named a tool and its arguments with no "type"',
    ),
    'final_line_stacked_onto_a_broken_tool_call_that_lost_its_type': (
        '{"name":"crm.get_deal","args":{"note":"a "quoted" word"}}\nFINAL>>> Deal 42 is won.',
        'named a tool and its arguments with no "type"',
    ),
    'claim_after_a_tool_call_whose_type_lost_its_colon': (
        '{"type" "tool_call", "name": "crm.get_deal", "args": {"deal_id": 42}}\nFINAL>>> Deal 42 is won.',
        'named a tool and its arguments with no "type"',
    ),
    'final_line_stacked_onto_a_tool_call_that_lost_its_type': (
        'Here is the result:\n{"name":"crm.get_deal","args":{"deal_id":42}}\nFINAL>>> Deal 42 is won.',
        'named a tool and its arguments with no "type"',
    ),
    'claim_after_a_tool_call_behind_a_code_block_that_never_closes': (
        '```c\nint main()\n{\n    return 0;\n```\n'
        '{"type":"tool_call","name":"crm.get_deal","args":{"deal_id":42}}\nFINAL>>> Deal 42 is won.',
        'not valid JSON',
    ),
    'claim_after_a_broken_tool_call_with_its_type_last': (
        '{"name":"crm.get_deal","args":{"note":"a "quoted" word"},"type":"tool_call"}\nFINAL>>> Deal 42 is won.',
        'not valid JSON',
    ),
    'tool_call_with_unquoted_keys': (
        '{type: "tool_call", name: "crm.get_deal", args: {deal_id: 42}}',
        'not valid JSON',
    ),
    'claim_after_a_broken_tool_call_that_opens_on_its_brace_line': (
        '{ "name": "crm.get_deal",\n  "args": {"note": "a "quoted" word"},\n  "type": "tool_call" }\n'
        'FINAL>>> Deal 42 is won.',
        'not valid JSON',
    ),
    'claim_after_a_broken_tool_call_inside_a_sentence': (
        'Looking it up: ' + BROKEN_TOOL_CALL + '\nFINAL>>> Deal 42 is won.',
        'not valid JSON',
    ),
    'broken_tool_call_inside_a_sentence': ('Looking it up: ' + BROKEN_TOOL_CALL, 'not valid JSON'),
    'member_after_the_content_of_a_broken_final': ('{"type":"final","content":"a "b"","note":"z"}', 'not valid JSON'),
    'broken_member_after_the_content_of_a_broken_final': (
        '{"type":"final","content":"a "b"","note":"z "w""}',
        'not valid JSON',
    ),
    'claim_after_a_tool_call_whose_first_key_lost_its_quote': (
        '{"name: "crm.get_deal", "type":"tool_call", "args":{"deal_id":42}}\nFINAL>>> Deal 42 is won.',
        'not valid JSON',
    ),
    'claim_after_a_tool_call_whose_type_has_an_extra_quote': (
        '{""type": "tool_call", "name":"crm.get_deal", "args":{"deal_id":42}}\nFINAL>>> Deal 42 is won.',
        'not valid JSON',
    ),
    'final_with_unquoted_keys': ('{type: "final", content: "Answer"}', 'not valid JSON'),
    'fenced_final_with_unquoted_keys': ('```json\n{type: "final", content: "Answer"}\n```', 'not valid JSON'),
    'final_with_unquoted_keys_after_the_marker': ('FINAL>>> {type: "final", content: "Answer"}', 'not valid JSON'),
    'cut_off_envelope_with_a_marker_line_in_it': (
        '{"type":"final","content":"Example:\nFINAL>>> partial',
        'not valid JSON',
    ),
    'broken_tool_call_with_an_escaped_type_after_a_line_of_prose': (
        'Sure, creating it now.\n{"type":"tool\\u005fcall","name":"crm.get_deal","args":{"note":"a "quoted" word"}}',
        'not valid JSON',
    ),
    'cut_off_final_with_an_escaped_type_after_a_line_of_prose': (
        'Here is the answer:\n{"type":"fin\\u0061l","content":"Acme reported revenue of 12',
        'not valid JSON',
    ),
}


class _Tools:
    """The host tools channel: the catalog, and a record of what was invoked."""

    def __init__(self, descriptors: Tuple[Dict[str, Any], ...]) -> None:
        self.list = list(descriptors)
        self.invocations: List[Tuple[str, Dict[str, Any]]] = []

    def invoke(self, tool_name: str, args: Dict[str, Any]) -> Any:
        self.invocations.append((tool_name, args))
        return {'deal_id': args.get('deal_id'), 'stage': 'won'}


class _Host:
    def __init__(self, descriptors: Tuple[Dict[str, Any], ...]) -> None:
        self.llm = object()
        self.tools = _Tools(descriptors)
        self.memory = None


class _Inner:
    """Stands in for ``iInstance.instance``: the answers lane and the status stream."""

    def __init__(self) -> None:
        self.pipeId = 7
        self.written: List[Any] = []
        self.sse: List[Tuple[Any, Dict[str, Any]]] = []

    def writeAnswers(self, answer: Any) -> None:
        self.written.append(answer)

    def sendSSE(self, type: Any, **kwargs: Any) -> None:
        self.sse.append((type, kwargs))


class _IInstance:
    """A node instance whose host is already built, so ``run_agent`` does no tool discovery."""

    def __init__(self, descriptors: Tuple[Dict[str, Any], ...]) -> None:
        self._agent_host = _Host(descriptors)
        self.instance = _Inner()


class _Run:
    """One finished agent run: what the caller got, and what the model was sent."""

    def __init__(self, payload: Dict[str, Any], prompts: List[str], instance: _IInstance) -> None:
        self.payload = payload
        self.prompts = prompts
        self.written = [answer.getText() for answer in instance.instance.written]
        self.sse = instance.instance.sse
        self.invocations = instance._agent_host.tools.invocations

    @property
    def content(self) -> str:
        return self.payload['content']

    @property
    def stop_reason(self) -> Any:
        return self.payload['meta'].get('stop_reason')


@pytest.fixture(scope='module')
def real_langchain():
    restore = real_langchain_or_skip()
    yield
    restore()


@pytest.fixture(scope='module')
def adapter(real_langchain):
    pytest.importorskip('langchain.agents', reason='langchain is not installed')
    module = load_adapter('agent_langchain/langchain.py', '_agent_langchain_final_envelope', LANGCHAIN_SYMBOLS)
    if not hasattr(module.LangChainDriver, 'run_agent'):
        pytest.skip('the engine ai package is not importable')
    return module


@pytest.fixture
def run(adapter):
    """Run the agent on QUESTION against a model that sends `replies` in order (the last one repeats)."""
    from ai.common.schema import Question

    def run_agent(*replies: str, tools: Tuple[Dict[str, Any], ...] = ()) -> _Run:
        prompts: List[str] = []

        def call_llm(context: Any, prompt: str, **kwargs: Any) -> str:
            prompts.append(prompt)
            return replies[min(len(prompts) - 1, len(replies) - 1)]

        # Built without __init__, which needs an engine IGlobal and its config.
        driver = adapter.LangChainDriver.__new__(adapter.LangChainDriver)
        driver._instructions = []
        driver._agent_description = ''
        driver._require_tool_call = False
        driver.call_llm = call_llm

        question = Question()
        question.addQuestion(QUESTION)
        instance = _IInstance(tools)
        return _Run(driver.run_agent(instance, question), prompts, instance)

    return run_agent


@pytest.mark.parametrize('case', ANSWERED)
def test_the_answer_reaches_the_caller_as_written(run, case):
    reply, calls, answer = ANSWERED[case]

    result = run(reply)

    assert result.content == answer
    assert result.written == [answer]
    assert result.stop_reason is None
    assert len(result.prompts) == calls
    assert not any('stop_reason' in data for _type, data in result.sse)


@pytest.mark.parametrize('case', FAILED)
def test_a_run_with_no_answer_ends_as_an_error(run, case):
    reply, said = FAILED[case]

    result = run(reply, tools=(GET_DEAL,))

    assert result.stop_reason == 'error'
    assert result.content.startswith(
        'LangChain agent invoke failed: ValueError: No valid tool call or final answer after 3 attempts.'
    )
    assert said in result.content
    assert GAVE_UP not in result.content
    # A parent agent reads this text as a tool result: it carries no instructions written for the model.
    assert 'Your last output' not in result.content
    assert 'Send ' not in result.content
    # Nor does it quote the reply: this text is logged and returned to the caller.
    assert 'It broke here' not in result.content
    assert result.written == [result.content]
    assert result.payload['stack'][0]['kind'] == 'RocketRide.agent.error.v1'
    # The last event is the stop status. The run's id may ride on it (#3360) and is not this test's subject.
    kind, status = result.sse[-1]
    assert kind == 'thinking'
    assert {key: value for key, value in status.items() if key != 'run_id'} == {
        'message': 'The run failed.',
        'stop_reason': 'error',
    }
    assert len(result.prompts) == 3
    assert result.invocations == []


@pytest.mark.parametrize(
    ('raw', 'calls', 'answer'),
    [
        (
            'Call it like this:\n\nclient.run("crm", {"name": "x", "args": [1]})',
            3,
            'Call it like this:\n\nclient.run("crm", {"name": "x", "args": [1]})',
        ),
        (
            'const f = () => {"name": "x", "args": [1]}',
            3,
            'const f = () => {"name": "x", "args": [1]}',
        ),
        ('{"type":"final","content":"bad \\ud800"}', 1, r'bad \ud800'),
        ('FINAL>>> {"type":"final","content":"bad \\udfff"}', 1, r'bad \udfff'),
        ('{"type":"final","content":{"text":"\\ud800"}}', 1, '{"text": "\\ud800"}'),
    ],
)
def test_code_examples_and_valid_json_surrogates_reach_the_answer_lane(run, raw, calls, answer):
    result = run(raw, tools=(GET_DEAL,))
    assert result.stop_reason is None
    assert result.content == answer
    assert result.written == [answer]
    assert result.content.encode('utf-8').decode('utf-8') == answer
    assert len(result.prompts) == calls
    assert result.invocations == []


@pytest.mark.parametrize(
    'expression',
    ['Calling crm.get_deal({call})', 'Tool call = {call}', 'Action: invoke(crm, {call})', 'return {call}'],
)
@pytest.mark.parametrize('claim', ['FINAL>>> Found.', '{"type":"final","content":"Found."}'])
def test_code_shaped_pending_work_with_a_claim_fails_without_running_a_tool(run, expression, claim):
    raw = expression.format(call='{"name":"crm.get_deal","args":{"deal_id":42}}') + '\n' + claim
    result = run(raw, tools=(GET_DEAL,))
    assert result.stop_reason == 'error'
    assert 'No valid tool call or final answer after 3 attempts.' in result.content
    assert result.written == [result.content]
    assert len(result.prompts) == 3
    assert result.invocations == []


def test_a_bare_json_answer_is_delivered_once_the_model_follows_the_hint(run):
    """Case D with a model that reads the retry hint: one extra call, then the JSON as the answer."""
    result = run(ANSWER_JSON, 'FINAL>>>' + ANSWER_JSON)

    assert result.content == ANSWER_JSON
    assert result.stop_reason is None
    assert len(result.prompts) == 2
    hint = result.prompts[1][len(result.prompts[0]) :]
    assert hint.startswith('\n\nsystem: Your last output parsed as JSON, but was not one of the allowed shapes.')
    assert 'write FINAL>>> followed by the JSON' in hint


def test_the_prompt_is_the_one_the_node_already_sent(run):
    """Models that follow it today are asked nothing new. FINAL>>> comes up only in a retry hint."""
    prompt = run('{"type":"final","content":"ok"}', tools=(GET_DEAL,)).prompts[0]

    assert 'system: You MUST respond with exactly one JSON object and nothing else.' in prompt
    assert 'system: {"type":"tool_call","name":"server.tool","args":{...}}' in prompt
    assert 'system: {"type":"final","content":"..."}' in prompt
    assert 'FINAL>>>' not in prompt
    assert '"type":"tool_calls"' not in prompt
    assert '"name": "crm.get_deal"' in prompt


def test_a_final_line_stacked_onto_a_tool_call_does_not_replace_the_call(run):
    """The tool runs and the answer comes from the turn after it, not from the claim the model stacked on."""
    result = run(
        '{"type":"tool_call","name":"crm.get_deal","args":{"deal_id":42}}\nFINAL>>> Deal 42 is lost.',
        'FINAL>>>Deal 42 is "won".',
        tools=(GET_DEAL,),
    )

    assert result.invocations == [('crm.get_deal', {'deal_id': 42})]
    assert result.content == 'Deal 42 is "won".'
    assert len(result.prompts) == 2


def test_a_tool_call_quoted_in_a_sentence_does_not_run_again(run):
    """The reply is prose about an earlier call, then the answer. The tool is not invoked and the answer is delivered."""
    result = run(
        'Previously: {"type":"tool_call","name":"crm.get_deal","args":{"deal_id":42}} returned won.\n'
        'FINAL>>> Deal 42 is won.',
        # Reached only when the quoted call is run: it ends the run, so that this test fails and does not loop.
        'FINAL>>>The tool ran again.',
        tools=(GET_DEAL,),
    )

    assert result.invocations == []
    assert result.content == 'Deal 42 is won.'
    assert result.stop_reason is None
    assert len(result.prompts) == 1


def test_a_run_that_fails_after_a_tool_call_still_reports_the_call(run):
    """The tool ran once. The turn after it never gives an answer, so the run fails, and the work done is on record."""
    result = run(
        '{"type":"tool_call","name":"crm.get_deal","args":{"deal_id":42}}',
        ANSWER_JSON,
        tools=(GET_DEAL,),
    )

    assert result.invocations == [('crm.get_deal', {'deal_id': 42})]
    assert result.stop_reason == 'error'
    assert 'not one of the allowed shapes' in result.content
    assert result.payload['meta']['tool_calls'] == 1
    assert len(result.prompts) == 4


def test_a_tool_call_wrapped_in_an_array_still_runs(run):
    """The node has always taken the first object of an array. Refusing it would fail runs that work today."""
    result = run(
        '[{"type":"tool_call","name":"crm.get_deal","args":{"deal_id":42}}]',
        '{"type":"final","content":"Deal 42 is won."}',
        tools=(GET_DEAL,),
    )

    assert result.invocations == [('crm.get_deal', {'deal_id': 42})]
    assert result.content == 'Deal 42 is won.'
    assert result.stop_reason is None


def test_a_tool_call_runs_and_its_result_reaches_the_next_turn(run):
    """The tool-call half of the protocol is unchanged: JSON in, the tool runs, the answer follows."""
    result = run(
        '{"type":"tool_call","name":"crm.get_deal","args":{"deal_id":42}}',
        'FINAL>>>Deal 42 is "won".',
        tools=(GET_DEAL,),
    )

    assert result.invocations == [('crm.get_deal', {'deal_id': 42})]
    assert result.content == 'Deal 42 is "won".'
    assert result.stop_reason is None
    assert result.payload['meta']['tool_calls'] == 1
    assert len(result.prompts) == 2
    assert '"stage": "won"' in result.prompts[1]


@pytest.mark.parametrize('prefix', ['Sets look like {1, 2}.\n', 'Example: {"x":1}\n'])
def test_a_tool_call_after_a_preamble_object_runs_once(run, prefix):
    result = run(
        prefix + '{"type":"tool_call","name":"crm.get_deal","args":{"deal_id":42}}',
        'FINAL>>> Deal 42 is won.',
        tools=(GET_DEAL,),
    )
    assert result.invocations == [('crm.get_deal', {'deal_id': 42})]
    assert result.content == 'Deal 42 is won.'
    assert result.stop_reason is None
    assert len(result.prompts) == 2


@pytest.mark.parametrize(
    'raw',
    [
        'FINAL>>>\n{"type":"tool_call","name":"crm.get_deal","args":{"deal_id":42}}',
        '{"type":"final","content":"Sent."}\n{"type":"tool_call","name":"crm.get_deal","args":{"deal_id":42}}',
    ],
)
def test_a_misplaced_tool_call_is_retried_then_runs_once(run, raw):
    result = run(
        raw,
        '{"type":"tool_call","name":"crm.get_deal","args":{"deal_id":42}}',
        'FINAL>>> Deal 42 is won.',
        tools=(GET_DEAL,),
    )
    assert result.invocations == [('crm.get_deal', {'deal_id': 42})]
    assert result.content == 'Deal 42 is won.'
    assert result.stop_reason is None
    assert len(result.prompts) == 3

    failed = run(raw, tools=(GET_DEAL,))
    assert failed.invocations == []
    assert failed.stop_reason == 'error'
    assert len(failed.prompts) == 3


def test_a_final_after_a_preamble_object_reaches_the_answer_lane(run):
    result = run('Example: {"x":1}\n{"type":"final","content":"done"}')
    assert result.content == 'done'
    assert result.written == ['done']
    assert result.stop_reason is None
    assert len(result.prompts) == 1
