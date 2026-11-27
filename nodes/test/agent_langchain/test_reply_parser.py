# =============================================================================
# RocketRide Engine
# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""How ``agent_langchain`` reads the host LLM's replies (#3367).

The driver parses a reply into a tool call or an answer, retries a reply that is
neither with a hint about what was wrong, and decides what a turn ends on when
the retries run out. These are the unit tests of that code, which lives in
``agent_langchain/langchain.py``. What a caller of the node gets is checked in
``test_final_envelope.py``.

The cases come from three places:

* the reply handling of ``agent_deepagent`` (the sentinel, salvage of a broken
  `final` envelope, the retry hint), which this node now has its own copy of;
* this node's older parser tests in ``nodes/test/test_agent_langchain_parser.py``,
  which still run and pass unchanged;
* issue #3367: a `final` envelope whose content is an object (C), a bare JSON
  object (D) and an envelope cut off mid-answer (I).

Runs against the real ``langchain_core``, because the parser hands LangChain an
``AIMessage`` and a stub would not show what the framework is given.
"""

from __future__ import annotations

import json
import re
from typing import Any, List, Tuple

import pytest

from .._real_langchain import LANGCHAIN_SYMBOLS, load_adapter, real_langchain_or_skip
from ..linear_time import assert_linear_time

FINAL_SENTINEL = 'FINAL>>>'
ANSWER_JSON = '{"company": "Acme", "revenue": 1200}'

# A payload from agent_deepagent's tests, trimmed to the break:
# the content quotes a name and the inner quotes are not escaped.
BROKEN_FINAL = (
    '{"type":"final","content":"Here\'s what I found:\\n\\n'
    '| Contact | Person in Pipedrive? |\\n'
    '| Richard Vasquez | **Not found**; no org named "EARTH" found |\\n\\n'
    'Would you like me to create person records?"}'
)
BROKEN_TOOL_CALL = '{"type":"tool_call","name":"crm.note_create","args":{"content":"a "quoted" note"}}'
REPAIRED_TOOL_CALL = '{"type":"tool_call","name":"crm.note_create","args":{"content":"a \\"quoted\\" note"}}'
CUT_OFF_FINAL = '{"type":"final","content":"Acme reported revenue of 12'
PARALLEL_CALLS = '{"type":"tool_calls","calls":[{"name":"a.one","args":{}},{"name":"b.two","args":{"x":1}}]}'
TOOL_CALL = '{"type":"tool_call","name":"crm.create","args":{"name":"Acme"}}'
PRETTY_BROKEN_TOOL_CALL = '{\n  "name": "crm.create",\n  "args": {"note": "a "quoted" word"},\n  "type": "tool_call"\n}'
# Text a model stacks onto a call: an answer about the result of work that has not run yet.
STACKED_FINAL = '\nFINAL>>> I created the Acme record.'

CODE_WITH_A_NAME_AND_ARGS = (
    'function run(job) {\n  return spawn(job.name, job.args);\n}\nrun({"name": "ls", "args": ["-la"]});'
)


class _Adapter:
    """The loaded ``langchain.py``. Filled by the module fixture, so collection alone imports nothing."""

    module: Any = None

    def __getattr__(self, name: str) -> Any:
        return getattr(_Adapter.module, name)


reply = _Adapter()


@pytest.fixture(scope='module', autouse=True)
def _loaded_adapter():
    restore = real_langchain_or_skip()
    try:
        _Adapter.module = load_adapter(
            'agent_langchain/langchain.py', '_agent_langchain_reply_parser', LANGCHAIN_SYMBOLS
        )
        yield
    finally:
        # Also when the load raised: the next test module must not find the swapped modules.
        _Adapter.module = None
        restore()


def parse(raw: Any) -> Any:
    return reply._parse_tool_call_envelope(raw)


def answer_of(turn: Any) -> str:
    """The text of a turn that is an answer and carries no tool call."""
    assert turn.tool_calls == []
    return turn.content


def scripted(*replies: Any) -> Tuple[Any, List[str]]:
    """A model that answers with `replies` in order (the last one repeats), and the feedback each call was given."""
    feedback_seen: List[str] = []

    def ask(feedback: str) -> Any:
        feedback_seen.append(feedback)
        return replies[min(len(feedback_seen) - 1, len(replies) - 1)]

    return ask, feedback_seen


# ---------------------------------------------------------------------------
# Premises
# ---------------------------------------------------------------------------


@pytest.mark.parametrize('raw', [BROKEN_FINAL, BROKEN_TOOL_CALL, CUT_OFF_FINAL])
def test_the_broken_payloads_really_are_invalid_json(raw):
    """If one of these ever parses, the tests built on it prove nothing."""
    with pytest.raises(json.JSONDecodeError):
        json.loads(raw)


# ---------------------------------------------------------------------------
# The sentinel
# ---------------------------------------------------------------------------


class TestSentinel:
    def test_an_answer_needs_no_escaping(self):
        answer = 'Here is a table with "EARTH" in it, and a \\ backslash, and {braces}.'

        assert answer_of(parse(FINAL_SENTINEL + answer)) == answer

    def test_a_json_answer_is_delivered_verbatim(self):
        """The structured-output case from #3367: the answer is JSON and arrives as the same JSON."""
        turn = parse(FINAL_SENTINEL + ANSWER_JSON)

        assert turn.content == ANSWER_JSON
        assert json.loads(turn.content) == {'company': 'Acme', 'revenue': 1200}
        assert turn.tool_calls == []

    def test_the_sentinel_wins_over_a_json_object_after_it(self):
        """An answer may quote an envelope. The braces after the marker stay part of the answer."""
        answer = 'The bad output was {"type":"final","content":"..."} and that is the bug.'

        assert parse(FINAL_SENTINEL + answer).content == answer

    def test_a_tool_call_that_quotes_the_sentinel_is_still_a_tool_call(self):
        """The sentinel opens a line. One buried inside a single-line envelope is quoted text."""
        raw = (
            '{"type":"tool_call","name":"crm.note_create",'
            '"args":{"content":"Reply with FINAL>>> when the booking is confirmed"}}'
        )

        turn = parse(raw)

        assert turn.content == ''
        assert turn.tool_calls[0]['name'] == 'crm.note_create'
        assert 'FINAL>>>' in turn.tool_calls[0]['args']['content']

    def test_a_sentinel_after_leading_prose_still_opens_its_own_line(self):
        assert parse('Thinking out loud first.\n\nFINAL>>> Here it is.').content == 'Here it is.'

    def test_the_marker_in_the_middle_of_a_line_is_not_the_sentinel(self):
        """Prose that mentions the marker is prose. Only a line that starts with it announces an answer."""
        assert parse('The marker FINAL>>> mid line') is None

    def test_an_indented_marker_still_opens_its_line(self):
        assert parse('Thinking.\n \tFINAL>>> Done.').content == 'Done.'

    @pytest.mark.parametrize(
        'after',
        [
            '{"type":"final","content":"No org named \\"EARTH\\" was found."}',
            # The same with its escaping still broken, and inside a fence.
            '{"type":"final","content":"No org named "EARTH" was found."}',
            '```json\n{"type":"final","content":"No org named \\"EARTH\\" was found."}\n```',
            # The fence with the envelope on its own line, which the node reads without the marker too.
            '```json {"type":"final","content":"No org named \\"EARTH\\" was found."}\n```',
        ],
    )
    def test_an_envelope_kept_after_the_marker_is_read_as_the_envelope(self, after):
        """
        A model that follows the hint can still write the envelope after the marker. Delivered as
        written, the person would be shown the protocol, which is the complaint in #3367.
        """
        assert answer_of(parse(FINAL_SENTINEL + ' ' + after)) == 'No org named "EARTH" was found.'

    @pytest.mark.parametrize(
        'after',
        [
            '{"type":"final","content":"example"} is the format.',
            '```json\n{"type":"final","content":"example"}\n```\nThat is the format.',
            # A code block and a JSON object are answers like any other, cut off or not.
            '```python\nprint(1)\n```',
            '```json\n{"company":"Acme"}\n```',
            '{"company":"Acme","revenue":12',
        ],
    )
    def test_an_answer_that_only_quotes_an_envelope_is_delivered_as_written(self, after):
        """Unwrapping it would drop the text around the envelope. Only text that is the envelope, whole, is read as one."""
        assert answer_of(parse(FINAL_SENTINEL + ' ' + after)) == after

    def test_an_answer_keeps_the_whitespace_that_means_something(self):
        """Four leading spaces make a markdown code block. Only the one separator comes off."""
        assert parse(FINAL_SENTINEL + '\n    indented = "code"').content == '    indented = "code"'

    @pytest.mark.parametrize(
        'after, expected',
        [
            (' Here it is.', 'Here it is.'),
            ('\tHere it is.', 'Here it is.'),
            ('\nHere it is.', 'Here it is.'),
            ('\r\nHere it is.', 'Here it is.'),
            # A blank first line is the answer's own, so it stays.
            ('\n\nHere it is.', '\nHere it is.'),
        ],
    )
    def test_only_one_separator_after_the_sentinel_is_removed(self, after, expected):
        assert parse(FINAL_SENTINEL + after).content == expected

    @pytest.mark.parametrize('after', ['', '   \n  '])
    def test_an_empty_sentinel_answer_is_not_an_answer(self, after):
        """Returning it would end the turn on an empty success. None sends the model through the retry."""
        assert parse(FINAL_SENTINEL + after) is None

    def test_a_tool_call_with_a_final_line_stacked_after_it_is_still_a_tool_call(self):
        """
        The first object counts. Reading the sentinel first would drop the call and deliver a
        sentence claiming the work was done.
        """
        turn = parse(TOOL_CALL + STACKED_FINAL)

        assert turn.content == ''
        assert [(c['name'], c['args']) for c in turn.tool_calls] == [('crm.create', {'name': 'Acme'})]

    def test_a_broken_tool_call_with_a_final_line_stacked_after_it_is_retried(self):
        """Not delivered as the stacked answer, and the hint asks for the call, not for prose."""
        raw = BROKEN_TOOL_CALL + STACKED_FINAL

        assert parse(raw) is None
        assert reply._parse_failure_hint(raw).endswith(
            'Generate the required tool call from the task and tool schema as one valid JSON object; do not answer in prose.'
        )

    def test_a_tool_call_after_a_line_of_prose_keeps_its_stacked_final_out_too(self):
        """Prose before a call never stopped the call from running, and a stacked final does not change that."""
        turn = parse('Sure, creating it now.\n' + TOOL_CALL + STACKED_FINAL)

        assert turn.content == ''
        assert turn.tool_calls[0]['name'] == 'crm.create'
        assert parse('Sure, creating it now.\n' + BROKEN_TOOL_CALL + STACKED_FINAL) is None

    def test_a_tool_call_on_a_line_of_its_own_is_read_in_any_member_order(self):
        """It parses, so its own type decides. Reading only a type-first call delivered the claim and ran nothing."""
        raw = 'Sure, creating it now.\n{"name":"crm.create","args":{"name":"Acme"},"type":"tool_call"}' + STACKED_FINAL

        assert [(c['name'], c['args']) for c in parse(raw).tool_calls] == [('crm.create', {'name': 'Acme'})]

    @pytest.mark.parametrize(
        'before, after',
        [
            ('Thought: I need to search.\nAction: ', ''),
            ('- ', ''),
            ('> ', ''),
            ('1. ', ''),
            ('`', '`'),
            ('```json5 ', '\n```'),
            ('Here are the calls: [', ']'),
            # A closing, a full stop, emphasis, a markup tag or a comment after it is no word.
            ('Action: ', '}'),
            ('Calling: ', '.'),
            ('Action: **', '**'),
            ('<tool_call>', '</tool_call>'),
            ('Action: ', ' // run it'),
            # Neither is another object that opens after it.
            ('Action: ', ' {"note": "next"}'),
            # And one with no word before it stands whatever comes after it.
            ('', ' is the call I am making.'),
            ('- ', ' is the next step.'),
            # A carriage return ends a line as a newline does.
            ('Note:\r', ' now'),
            ('Action: ', '\rnow'),
        ],
    )
    def test_a_tool_call_that_is_not_quoted_stands(self, before, after):
        """Only a call with a word before it and a word after it on its line is quoted. Read as quoted, its claim was delivered and nothing ran."""
        turn = parse(before + TOOL_CALL + after + STACKED_FINAL)

        assert turn.content == ''
        assert turn.tool_calls[0]['name'] == 'crm.create'

    @pytest.mark.parametrize('before, after', [('{', '} (searching)'), ('{ ', ' } now'), ('{-} ', ' now')])
    def test_a_brace_before_a_tool_call_on_its_line_is_no_word(self, before, after):
        """So the call is not quoted and its claim is not delivered. The reply is read as its first object, which is no envelope."""
        assert parse(before + TOOL_CALL + after + STACKED_FINAL) is None

    def test_a_type_nested_in_the_arguments_does_not_decide_what_the_reply_is(self):
        """The envelope's own "type" does, whatever the key order."""
        raw = '{"args":{"type":"final"},"type":"tool_call","name":"crm.create"}' + STACKED_FINAL

        turn = parse(raw)

        assert turn.content == ''
        assert (turn.tool_calls[0]['name'], turn.tool_calls[0]['args']) == ('crm.create', {'type': 'final'})

    def test_several_calls_with_a_final_line_stacked_after_them_are_not_answered_with_that_line(self):
        """The node does not run the form, and it does not deliver the claim stacked onto it either."""
        raw = PARALLEL_CALLS + STACKED_FINAL

        assert parse(raw) is None
        assert reply._parse_failure_hint(raw).endswith('do not answer in prose.')

    @pytest.mark.parametrize(
        'call',
        [
            'Here is the result:\n{"name":"crm.create","args":{}}',
            # Bad escaping in the arguments does not make it less of a call, and neither does an escape in its name.
            '{"name":"crm.create","args":{"note":"a "quoted" word"}}',
            '{"name":"crm.\\u0063reate","args":{"note":"a "quoted" word"}}',
        ],
    )
    def test_a_final_line_stacked_onto_a_tool_call_that_lost_its_type_is_not_delivered(self, call):
        """A name and its arguments with no "type" is a call that will not run. Its claim is not the answer."""
        raw = call + '\nFINAL>>> Created.'

        assert parse(raw) is None
        assert reply._parse_failure_hint(raw).endswith('do not answer in prose.')

    def test_prose_with_braces_before_the_sentinel_does_not_take_it_away(self):
        assert parse('Use {curly} braces here.\nFINAL>>> Done.').content == 'Done.'

    @pytest.mark.parametrize(
        'before',
        [
            'Previously: {"type":"tool_call","name":"s","args":{}} returned 5.',
            # The same when the quoted call has no "type".
            'Previously: {"name":"s","args":{}} returned 5.',
        ],
    )
    def test_a_tool_call_quoted_inside_a_sentence_does_not_take_the_sentinel_away(self, before):
        """It is prose about a call. Reading it as the call ran the tool again and dropped the answer."""
        assert answer_of(parse(before + '\nFINAL>>> 5')) == '5'

    @pytest.mark.parametrize(
        'before',
        [
            'Thinking about a tool call.',
            'A note such as {"note": "x"} was kept.',
            '{"note": "x"}',
            # A JSON object that does not parse and was never an envelope.
            '{"note": "a "quoted" word"}',
            # A name alone is not a tool call that lost its type.
            '{"name": "crm.create"}',
            # Arguments named after an object are a tool call's only when the object has a name.
            '{"note": "a "quoted" word"}\nThe "args": member was empty.',
            # A block of code with its brace on a line of its own is not an envelope, whatever it holds
            # further in or is followed by.
            'if (x)\n{\n    call(args);\n}',
            'function run()\n{\n  return call({ name: "x", args: { id: 1 } });\n}',
            '    void Run()\n    {\n        Go();\n    }\nCall it with "args": none.',
            # A config with a comment in it does not parse. Its members are not a tool call's:
            # arguments with no name, and a name and arguments one level further in.
            '{\n  "cmd": "run",\n  "args": ["--fast"]  // fast\n}',
            '{\n  "configurations": [\n    {\n      "name": "Launch",\n      "args": ["--verbose"],  // flags\n    }\n  ]\n}',
            # Code that names a name and arguments is not a tool call: a Python dict with a literal JSON does
            # not have, a list of jobs in single quotes, an object literal with no quotes, a sentence about one.
            'payload = {"name": "demo", "enabled": True}\nrequests.post(url, json={"args": payload})',
            "JOBS = [\n    {\n        'name': 'resize',\n        'args': {'w': 100},\n    },\n]",
            '{name: "crm.get_deal", args: {deal_id: 42}}',
            'Use { "name": "Launch", request: "launch" } and set "args": ["--inspect"].',
            '{\n  "name": "Launch",\n  "configurations": [{"args": ["--verbose"]}],  // flags\n}',
            # What is inside an answer that parses is the answer's own: a value that looks like a call, a list of jobs.
            '{\n  "company": "Acme",\n  "last_call": {"type":"tool_call","name":"x","args":{}}\n}',
            '```json\n{\n  "jobs": [\n    {"name": "build", "args": ["-v"]},\n    {"name": "test", "args": []}\n  ]\n}\n```',
            # After an object of another type that never closes, only a tool call counts.
            '{"type":"note","draft":[\n{"type":"final","content":"old"}',
            # What the text names before an object says nothing about it.
            'A call has "type": "tool_call" in it.\n{"note": "a "quoted" word"}',
            # A type with no quotes makes a tool call only with no word before it on its line, and only a tool call's does.
            'In JavaScript the call is {type: "tool_call", name: "s"} and it returned 5.',
            "call = {'type': 'tool_call', 'name': 'search', 'args': {}}",
            # A brace that opens no object is prose, whatever is named after it.
            'Use {curly} braces. A call has "type": "tool_call" in it.',
            # A tool call that parses inside a sentence is quoted, also when it runs over several lines.
            'The call was {\n  "type": "tool_call",\n  "name": "s",\n  "args": {}\n} and it returned 5.',
            # A `final` envelope on a line of its own after prose is not work left undone.
            'The format is:\n{"type":"final","content":"old"}',
            # A name and arguments with no type are a tool call only as the first object or with no word before them.
            CODE_WITH_A_NAME_AND_ARGS,
            # And only when the name is a string.
            'Contact:\n{"name": {"first": "Ada", "last": "Lovelace"}, "args": []}',
        ],
    )
    def test_other_text_before_the_sentinel_does_not_take_it_away(self, before):
        """
        Only an envelope that is not finished keeps the marker from being read: a tool call or a
        broken `final` that is not quoted, or a tool call anywhere that does not parse.
        """
        assert parse(before + '\nFINAL>>> Done.').content == 'Done.'

    def test_code_that_passes_a_name_and_arguments_is_an_answer(self):
        """The object is not the reply's first and has a word before it on its line: it is code, not a tool call that lost its type."""
        ask, _feedback = scripted(CODE_WITH_A_NAME_AND_ARGS)

        assert reply._run_model_turn(ask).content == CODE_WITH_A_NAME_AND_ARGS

    def test_a_marker_with_nothing_after_it_leaves_a_final_envelope_that_parses_as_the_answer(self):
        """Only a `final` envelope: a quoted tool call before a bare marker does not run and is not an answer."""
        assert parse('{"type":"final","content":"42"}\n' + FINAL_SENTINEL).content == '42'
        assert parse('Earlier ' + TOOL_CALL + ' returned 5.\n' + FINAL_SENTINEL) is None

    @pytest.mark.parametrize(
        'before',
        [
            # A tool call that is not the first object does not run, and its claim is not delivered either.
            '{"note":"planning"}\n' + TOOL_CALL,
            # A name and its arguments with no "type" is a call that will not run.
            '{"name":"crm.create","args":{}}',
            'Calling it:\n{"name":"crm.create","args":{"name":"Acme"}}',
            # A call too broken to parse is still one, with its type last or with none.
            '{"name":"notes.save","args":{"text":"He said "hi""},"type":"tool_call"}',
            '{"name":"crm.create","args":{"note":"a "quoted" word"}}',
            # The same pretty-printed, its type last: every line up to the closing brace is the call's.
            PRETTY_BROKEN_TOOL_CALL,
            PRETTY_BROKEN_TOOL_CALL.replace('\n', '\r\n'),
            '{\n"name": "crm.create",\n"args": {"note": "a "quoted" word"}\n}',
            '{"name":"crm.\\u0063reate","args":{"note":"a "quoted" word"}}',
            'Creating.\n{"name":"crm.create","type":"tool_call","args":{"note":"a "b" c"}}',
            # Its first member on the line of its brace, a comment there, or an object among its members.
            '{ "name": "crm.create",\n  "args": {"note": "a "quoted" word"},\n  "type": "tool_call" }',
            '{ // call\n  "name": "crm.create",\n  "args": {"note": "a "quoted" word"},\n  "type": "tool_call"\n}',
            '{\n"meta": {\n"x": 1\n},\n"name": "crm.create",\n"args": {"note": "a "quoted" word"},\n"type": "tool_call"\n}',
            # A call that does not parse is one inside a sentence too, on one line or on several.
            'Creating it now: ' + BROKEN_TOOL_CALL,
            'Calling: ' + PRETTY_BROKEN_TOOL_CALL,
            'Calling: {"name":"crm.create","args":{"note":"a "quoted" word"}}',
            # A stray quote puts the reading out of step. What the text names after it then decides:
            # a tool call's type, or the arguments of an object that has a name and no type.
            '{\n  "name": "crm."create",\n  "args": {"name": "Acme"},\n  "type": "tool_call"\n}',
            '{\n  "name": "crm."create",\n  "args": {"name": "Acme"}\n}',
            '{"args": {"src": "print("}")"}, "name": "code.run", "type": "tool_call"}',
            # Inside a second pair of braces it is still the call.
            '{' + TOOL_CALL + '}',
            # An object of another type that never closes, or has a quote out of place, does not take
            # the call after it with it.
            '{"type":"note","draft":[\n' + TOOL_CALL,
            'Schema: {"type": "object", "properties": {\n' + BROKEN_TOOL_CALL,
            '{"type":"text","text":"use "{" here"}\n' + TOOL_CALL,
            # A brace that opens no object hides nothing after it: a block of code that was never closed,
            # a lone brace, a brace in a sentence with an odd quote in it or with the call behind it.
            '```c\nint main()\n{\n    return 0;\n```\n' + TOOL_CALL,
            '{\n' + TOOL_CALL,
            'Sizes like {12" pipe} are common.\n{"type":"tool_call","name":"grep","args":{"pattern":"^}"}}',
            'The `{` key opens a block. Searching: ' + BROKEN_TOOL_CALL,
            # A call with no type and no word after it stands as written, whatever comes before it on the line.
            'Calling it: {"name":"crm.create","args":{}}',
            # A comment does not make it less of a call, with its type or without.
            '{\n  // create it\n  "name": "crm.create",\n  "args": {"name": "Acme"}\n}',
            # Written as a JavaScript object or a Python dict, its type right after the brace.
            '{type: "tool_call", name: "crm.get_deal", args: {deal_id: 42}}',
            "{'type': 'tool_call', 'name': 'crm.create', 'args': {'name': 'Acme'}}",
            # Wrapped in an object that does not parse for a comment: the wrapper's own text names the call.
            '{\n  "step": 1, // one\n  "call":\n  ' + TOOL_CALL + '\n}',
        ],
    )
    def test_a_claim_after_a_tool_call_that_does_not_run_is_not_delivered(self, before):
        """
        The marker line is a claim about the call: one that is not quoted, or one anywhere that
        does not parse. The reply is retried.
        """
        assert parse(before + '\nFINAL>>> Created.') is None

    def test_a_tool_call_after_another_object_is_asked_for_again(self):
        """The retry must not point that reply at the sentinel: the claim alone would then be delivered."""
        raw = '{"note":"planning"}\n' + TOOL_CALL + '\nFINAL>>> Created.'

        assert reply._parse_failure_hint(raw).endswith('do not answer in prose.')

    @pytest.mark.parametrize('wrapped', ['[' + TOOL_CALL + ']', '```json [' + TOOL_CALL + ']\n```'])
    def test_a_tool_call_in_an_array_keeps_its_stacked_final_out_too(self, wrapped):
        assert parse(wrapped + STACKED_FINAL).tool_calls[0]['name'] == 'crm.create'

    @pytest.mark.parametrize('before', ['{"type":"final","content":"old"}', '{"type":"final","content":"old"} Done.'])
    def test_a_marker_after_a_final_envelope_that_parses_is_still_the_sentinel(self, before):
        """An envelope that parses is finished. Also when the answer after the marker ends the way an envelope does."""
        assert parse(before + '\nFINAL>>> {"company":"Acme"}').content == '{"company":"Acme"}'

    @pytest.mark.parametrize(
        'raw',
        [
            # The line may be the answer's own text ...
            '{"type":"final","content":"Example:\nFINAL>>> sample"}',
            # ... or the sentinel after an envelope that had already closed.
            '{"type":"final","content":"an "old" one"} Done.\nFINAL>>> {"company":"Acme"}',
            '{"type":"final","content":"an "old" one"}\nFINAL>>> Done.',
        ],
    )
    def test_a_marker_line_in_or_after_a_broken_final_envelope_is_retried(self, raw):
        """
        Unescaped content cannot say which quote and brace were the envelope's own, so neither reading
        can be trusted. The hint sends the answer to the marker, where nothing is ambiguous.
        """
        assert parse(raw) is None
        assert reply._salvage_final_content(raw) is None
        assert f'send the answer as {FINAL_SENTINEL}' in reply._parse_failure_hint(raw)

    @pytest.mark.parametrize(
        'raw',
        [
            '{"type":"final","content":"Example:\nFINAL>>> partial',
            # An escaped quote and a brace in the content close nothing.
            '{"type":"final","content":"see {\\"k\\":\\"v\\"} and\nFINAL>>> partial',
            # The same with content that is an object, and with the members the other way round.
            '{"type":"final","content":{"note":"Example:\nFINAL>>> partial',
            '{"content":{"note":"Example:"},"type":"final","more":"x\nFINAL>>> partial',
            # A line of prose before the envelope, or an array around it, changes nothing.
            'Here is the result:\n{"type":"final","content":"Example:\nFINAL>>> partial',
            '[{"type":"final","content":"Example:\nFINAL>>> partial',
        ],
    )
    def test_a_marker_line_inside_an_envelope_that_never_closes_is_not_an_answer(self, raw):
        """The reply is a cut-off envelope, whatever one of its lines starts with."""
        assert parse(raw) is None

    @pytest.mark.parametrize(
        'after',
        [
            '{"type":"final","content":"Acme reported revenue of 12',
            '{"type":"final","content":"a "b" c"} Hope that helps!',
            # Cut off inside content that is an object, and with the members the other way round.
            '{"type":"final","content":{"company":"Acme"',
            '{"content":"Acme reported revenue","type":"final"',
            # A type named inside the content does not make it something else, in either member order.
            '{"type":"final","content":{"type":"tool_call","note":"unfinished',
            '{"content":{"type":"tool_call","note":"unfinished"},"type":"final"',
        ],
    )
    def test_an_envelope_that_was_cut_off_after_the_marker_is_not_an_answer(self, after):
        """It is retried, as the same reply is without the marker. Delivered, it was a partial answer inside the protocol."""
        assert parse(FINAL_SENTINEL + ' ' + after) is None

    def test_a_marker_after_an_object_content_envelope_that_closed_is_still_the_sentinel(self):
        raw = '{"type":"final","content":{"old":true}}\nFINAL>>> {"company":"Acme"}'

        assert answer_of(parse(raw)) == '{"company":"Acme"}'

    @pytest.mark.parametrize(
        'before',
        [
            '{"type":"final","content":"old"}',
            '{"type":"final","content":"old"} Done.',
            '{"type":"final","content":"old","done":true}',
        ],
    )
    def test_a_marker_after_a_final_envelope_that_already_closed_is_still_the_sentinel(self, before):
        """An envelope that parses has closed for certain. Also when the answer after the marker ends the way an envelope does."""
        assert parse(before + '\nFINAL>>> {"company":"Acme"}').content == '{"company":"Acme"}'

    @pytest.mark.parametrize(
        'raw',
        [
            # Closed, with a word of prose after it? Or still open, with a quote and a brace of its own?
            '{"type":"final","content":"an "old" one"} Done.\nFINAL>>> {"company":"Acme"}',
            # The same question when the quote and brace are the last thing before the marker line.
            '{"type":"final","content":"an "old" one"}\nFINAL>>> {"company":"Acme"}',
            '{"type":"final","content":"Example: {"k":"v"}\nFINAL>>> partial',
            '{"type":"final","content":"Example: {"k":"v"} is an object.\nFINAL>>> is the marker"}',
            '{"type":"final","content":"Example: {"k":"v"} and\nFINAL>>> partial',
        ],
    )
    def test_a_marker_after_a_broken_envelope_that_may_have_closed_is_not_read(self, raw):
        """
        Unescaped content cannot say which quote and brace were the envelope's own. Reading the marker
        delivered the tail of a partial answer. Reading the envelope delivered both parts as one. The
        reply is retried, and the hint sends the answer to the marker, where nothing is ambiguous.
        """
        assert parse(raw) is None
        assert f'send the answer as {FINAL_SENTINEL}' in reply._parse_failure_hint(raw)


# ---------------------------------------------------------------------------
# JSON envelopes
# ---------------------------------------------------------------------------


class TestJsonEnvelope:
    def test_several_calls_in_one_reply_are_refused(self):
        """The prompt never offered the form, and the node does not start running calls concurrently because of it."""
        assert parse(PARALLEL_CALLS) is None

    def test_a_well_formed_final_is_still_accepted(self):
        assert answer_of(parse('{"type":"final","content":"All done."}')) == 'All done.'

    def test_a_final_with_an_escaped_json_answer_is_unescaped(self):
        raw = json.dumps({'type': 'final', 'content': ANSWER_JSON})

        assert parse(raw).content == ANSWER_JSON

    def test_a_final_whose_content_is_an_object_comes_back_as_json(self):
        """#3367 case C. It used to come back as Python's repr of the dict, which is not JSON."""
        turn = parse('{"type":"final","content":' + ANSWER_JSON + '}')

        assert turn.content == ANSWER_JSON
        assert json.loads(turn.content) == {'company': 'Acme', 'revenue': 1200}

    def test_a_final_whose_content_is_a_list_comes_back_as_json(self):
        turn = parse('{"type":"final","content":[{"city":"Zürich","ok":true,"note":null}]}')

        assert turn.content == '[{"city": "Zürich", "ok": true, "note": null}]'

    @pytest.mark.parametrize('content, text', [('true', 'true'), ('42', '42'), ('1.5', '1.5'), ('null', '')])
    def test_a_final_whose_content_is_a_scalar_comes_back_as_json(self, content, text):
        """`true` stays `true`, not Python's `True`. A null content is an empty answer, as before."""
        assert parse('{"type":"final","content":' + content + '}').content == text

    def test_a_tool_call_parses(self):
        turn = parse('{"type":"tool_call","name":"srv.tool","args":{"a":1}}')

        assert turn.content == ''
        assert [(c['type'], c['name'], c['args']) for c in turn.tool_calls] == [('tool_call', 'srv.tool', {'a': 1})]

    def test_tool_call_ids_are_opaque_and_distinct(self):
        raw = '{"type":"tool_call","name":"srv.tool","args":{}}'

        first, second = parse(raw).tool_calls[0]['id'], parse(raw).tool_calls[0]['id']

        assert re.fullmatch(r'call_[0-9a-f]{12}', first)
        assert first != second

    def test_tool_call_args_default_to_an_empty_dict(self):
        assert parse('{"type":"tool_call","name":"srv.ping"}').tool_calls[0]['args'] == {}

    def test_null_tool_call_args_are_an_empty_dict(self):
        assert parse('{"type":"tool_call","name":"srv.ping","args":null}').tool_calls[0]['args'] == {}

    @pytest.mark.parametrize(
        'args, expected',
        [
            ('"hello"', {'input': 'hello'}),
            ('[1, 2]', {'input': [1, 2]}),
            # A false, 0 or empty value is still what the model sent, and still reaches the tool.
            ('false', {'input': False}),
            ('0', {'input': 0}),
            ('""', {'input': ''}),
            ('[]', {'input': []}),
        ],
    )
    def test_tool_call_args_that_are_not_an_object_are_wrapped(self, args, expected):
        turn = parse('{"type":"tool_call","name":"srv.echo","args":' + args + '}')

        assert turn.tool_calls[0]['args'] == expected

    @pytest.mark.parametrize(
        'raw, name',
        [
            (
                'I will list the labels first.\n{"type":"tool_call","name":"gmail.label_list","args":{}}',
                'gmail.label_list',
            ),
            ('```json\n{"type":"tool_call","name":"t","args":{}}\n```', 't'),
            # A second object stacked onto the first is a duplicate or a made-up `final`: only the first counts.
            ('{"type":"tool_call","name":"a.one","args":{}}\n{"type":"final","content":"done"}', 'a.one'),
        ],
    )
    def test_a_tool_call_is_found_inside_noise(self, raw, name):
        assert parse(raw).tool_calls[0]['name'] == name

    @pytest.mark.parametrize(
        'raw',
        [
            '[' + TOOL_CALL + ']',
            '[' + TOOL_CALL + ',{"type":"tool_call","name":"b.two","args":{}}]',
            '[' + TOOL_CALL + ',{"type":"tool_call","name":"b.two","args":{}}] Done.',
            'Here are the calls: [' + TOOL_CALL + ',{"type":"tool_call","name":"b.two","args":{}}]',
        ],
    )
    def test_the_first_object_of_an_array_is_the_envelope(self, raw):
        """As it always was in this node, with or without text around the array. Refusing it failed runs that work."""
        assert [c['name'] for c in parse(raw).tool_calls] == ['crm.create']

    def test_a_final_wrapped_in_an_array_is_the_answer(self):
        assert answer_of(parse('[{"type":"final","content":"ok"}]')) == 'ok'

    @pytest.mark.parametrize(
        'raw',
        [
            # The object on the fence's own line.
            '```json ' + TOOL_CALL + '\n```',
            # A fenced note first, then the call.
            '```\nnote\n```\n' + TOOL_CALL,
        ],
    )
    def test_a_tool_call_is_found_whatever_the_fence_looks_like(self, raw):
        assert parse(raw).tool_calls[0]['name'] == 'crm.create'

    def test_a_final_in_a_fence_that_never_closes_keeps_the_fence_in_its_content(self):
        raw = '```json\n{"type":"final","content":"Use:\\n```py\\nprint(1)\\n```"}'

        assert answer_of(parse(raw)) == 'Use:\n```py\nprint(1)\n```'

    @pytest.mark.parametrize(
        'raw, content',
        [
            ('Sure, here is the result:\n{"type":"final","content":"ok"}', 'ok'),
            ('{"type":"final","content":"done"} Here is my explanation.', 'done'),
        ],
    )
    def test_a_final_is_found_inside_noise(self, raw, content):
        assert parse(raw).content == content

    @pytest.mark.parametrize(
        'raw',
        [
            'not json at all',
            '',
            '["array", "not", "object"]',
            '{"type":"unknown","data":"x"}',
            '{"type":"tool_call","name":"","args":{}}',
            '{"type":"tool_call","args":{"a":1}}',
            None,
            42,
        ],
    )
    def test_anything_else_is_refused(self, raw):
        assert parse(raw) is None

    def test_a_bare_json_object_is_refused_not_delivered(self):
        """#3367 case D. It may be a tool call that lost its "type", so it is never taken as the answer."""
        assert parse(ANSWER_JSON) is None


# ---------------------------------------------------------------------------
# Salvage of a `final` envelope that does not parse
# ---------------------------------------------------------------------------


class TestSalvage:
    def test_an_unparseable_final_envelope_gives_its_answer(self):
        turn = parse(BROKEN_FINAL)

        assert turn.content.startswith("Here's what I found:")
        # The escapes that were right are still honoured ...
        assert '\n\n| Contact |' in turn.content
        # ... and the stray quote that broke the envelope survives as itself.
        assert 'no org named "EARTH" found' in turn.content
        assert turn.tool_calls == []

    def test_a_json_answer_with_unescaped_quotes_is_recovered_exactly(self):
        """#3367 case A: the structured answer every model writes with bare quotes."""
        turn = parse('{"type":"final","content":"' + ANSWER_JSON + '"}')

        assert turn.content == ANSWER_JSON

    def test_a_json_answer_pasted_unescaped_keeps_its_own_escapes(self):
        """
        The answer is a JSON document with a quoted word and a line break inside its values, pasted
        into the envelope as it is. Its backslashes are its own. Undoing them delivered invalid JSON.
        """
        answer = {'company': 'Acme Corp', 'quote': 'Its CEO called it a "record" year.', 'note': 'one\ntwo'}
        document = json.dumps(answer)

        turn = parse('{"type":"final","content":"' + document + '"}')

        assert turn.content == document
        assert json.loads(turn.content) == answer

    def test_a_fenced_json_answer_pasted_unescaped_keeps_its_own_escapes(self):
        """The same document in a markdown fence, which is how models like to write JSON."""
        document = json.dumps({'company': 'Acme Corp', 'quote': 'Its CEO called it a "record" year.'})
        fenced = '```json\n' + document + '\n```'

        turn = parse('{"type":"final","content":"' + fenced + '"}')

        assert turn.content == fenced
        assert json.loads(document) == {'company': 'Acme Corp', 'quote': 'Its CEO called it a "record" year.'}

    def test_prose_with_a_stray_quote_still_has_its_escapes_undone(self):
        """Content that is not a JSON document was escaped for the envelope, apart from the quote that broke it."""
        assert (
            parse('{"type":"final","content":"Line one.\\nShe said "no" twice."}').content
            == 'Line one.\nShe said "no" twice.'
        )

    def test_a_literal_line_break_in_the_content_is_kept(self):
        """#3367 case F. JSON forbids a raw line break inside a string."""
        assert parse('{"type":"final","content":"Line one.\nLine two."}').content == 'Line one.\nLine two.'

    def test_whitespace_before_the_closing_brace_is_allowed(self):
        assert parse('{ "type": "final", "content": "a "b" c"\n}\n').content == 'a "b" c'

    @pytest.mark.parametrize(
        'raw',
        [
            CUT_OFF_FINAL,
            # The content's quote closed but the object did not.
            '{"type":"final","content":"Acme reported "revenue" of 1200"',
            # Cut off inside a JSON answer, after an inner object closed.
            '{"type":"final","content":"{"items": [{"name": "x"}, {"name": "y',
        ],
    )
    def test_an_envelope_that_does_not_close_is_not_salvaged(self, raw):
        """#3367 case I. A reply cut off mid-answer is not delivered as a finished one."""
        assert reply._salvage_final_content(raw) is None
        assert parse(raw) is None

    def test_a_broken_envelope_with_text_after_it_is_retried_not_salvaged(self):
        """
        The price of telling a cut-off answer from a finished one: in unescaped content, only the end of
        the reply says which `"}` is the envelope's own. The retry is pointed at the sentinel.
        """
        raw = '{"type":"final","content":"No org named "EARTH" was found."} Hope that helps!'

        assert reply._salvage_final_content(raw) is None
        assert parse(raw) is None
        assert f'send the answer as {FINAL_SENTINEL}' in reply._parse_failure_hint(raw)

    def test_a_reply_cut_exactly_after_an_inner_closing_still_reads_as_closed(self):
        """The known limit of the same check, pinned so a change to it is a decision and not an accident."""
        assert parse('{"type":"final","content":"Here: {"a":"b"}').content == 'Here: {"a":"b'

    def test_a_reply_cut_off_after_an_escaped_quote_and_a_brace_is_not_closed(self):
        """The closing quote is never escaped, so this one is the answer's own and the reply was cut off there."""
        raw = '{"type":"final","content":"The result is {\\"a\\": \\"b\\"}'

        assert reply._salvage_final_content(raw) is None
        assert parse(raw) is None

    def test_an_escaped_backslash_before_the_closing_quote_still_closes(self):
        assert parse('{"type":"final","content":"a "b" path C:\\\\"}').content == 'a "b" path C:\\'

    @pytest.mark.parametrize(
        'raw',
        [
            '{"type":"final","content":"a "b"","note":"z"}',
            '{"type":"final","content":"a "b" c", "confidence": "high"}',
            '{"type":"final","content":"a "b"","note":"z "w""}',
            '{"type":"final","content":"a "b"","note":"z "w"","extra":"other"}',
        ],
    )
    def test_a_member_after_the_content_is_not_delivered_with_the_answer(self, raw):
        """The content ended before the reply did. Reading on to the last quote and brace delivered the other member too."""
        assert reply._salvage_final_content(raw) is None
        assert parse(raw) is None
        assert f'send the answer as {FINAL_SENTINEL}' in reply._parse_failure_hint(raw)

    @pytest.mark.parametrize(
        'answer',
        [
            # The structured answer of #3367 with a fence or a lead-in, and one with text after it.
            '```json\n{"company":"Acme","stage":"won"}\n```',
            'Result: {"company": "Acme", "revenue": 1200}',
            '[{"a":"x","b":"y"}] is the list.',
            # A list of quoted words, and a quoted word before a colon.
            'Say "yes", "no" or "maybe".',
            'Either "yes", "no": pick one.',
        ],
    )
    def test_json_and_quoted_words_inside_the_answer_are_not_taken_for_a_member(self, answer):
        """Only text that reads as the envelope's other members, up to its closing brace, ends the content early."""
        assert parse('{"type":"final","content":"' + answer + '"}').content == answer

    def test_a_fenced_envelope_is_recovered_like_a_bare_one(self):
        """Models fence JSON whatever the prompt says. The fence is not part of the answer."""
        raw = '```json\n{"type":"final","content":"No org named "EARTH" was found."}\n```'

        assert answer_of(parse(raw)) == 'No org named "EARTH" was found.'

    def test_a_fenced_envelope_that_was_cut_off_is_not_salvaged(self):
        raw = '```json\n{"type":"final","content":"Acme reported "revenue" of 12'

        assert reply._salvage_final_content(raw) is None
        assert parse(raw) is None

    @pytest.mark.parametrize(
        'second',
        [
            '{"type":"final","content":"second"}',
            '{"content":"second","type":"final"}',
            '{"type":"final"}',
            # Its type decides wherever it comes, also after content that is no string.
            '{"content":42,"type":"final"}',
            '{"content":{"a":1},"note":true,"type":"final"}',
        ],
    )
    def test_a_second_envelope_stacked_after_a_broken_one_is_not_its_content(self, second):
        """Its closing would otherwise be taken for the first one's, and the person shown both envelopes."""
        raw = '{"type":"final","content":"a "b" c"}\n' + second

        assert reply._salvage_final_content(raw) is None
        assert parse(raw) is None

    def test_an_envelope_quoted_later_in_the_answer_does_not_make_the_object_before_it_one(self):
        """The object right after the closing decides. Reading on to a later example refused a finished answer."""
        raw = '{"type":"final","content":"Before {"a":"b"} {"c":"d"}; schema {"type":"final"}; done."}'

        assert parse(raw).content == 'Before {"a":"b"} {"c":"d"}; schema {"type":"final"}; done.'

    def test_an_object_that_is_no_envelope_after_a_closing_is_part_of_the_answer(self):
        """Only a second envelope makes a reply two envelopes. An answer may hold one JSON object after another."""
        raw = '{"type":"final","content":"Before {"a":"b"} {"c":"d"} after "it"."}'

        assert parse(raw).content == 'Before {"a":"b"} {"c":"d"} after "it".'

    @pytest.mark.parametrize(
        'text, at, escaped',
        [('a"', 1, False), ('a\\"', 2, True), ('a\\\\"', 3, False), ('\\\\\\"', 3, True), ('"', 0, False)],
    )
    def test_a_quote_is_escaped_by_an_odd_number_of_backslashes(self, text, at, escaped):
        assert reply._is_escaped(text, at) is escaped

    def test_a_malformed_tool_call_is_never_salvaged(self):
        """Rescuing one would turn work the agent meant to do into a sentence saying it was done."""
        assert reply._salvage_final_content(BROKEN_TOOL_CALL) is None
        assert parse(BROKEN_TOOL_CALL) is None

    def test_ordinary_prose_is_left_alone(self):
        assert reply._salvage_final_content('I could not do that.') is None

    def test_unescaping_handles_the_escapes_that_were_right(self):
        assert reply._unescape_json_string_body('a\\nb\\tc\\"d\\\\e\\u00e9') == 'a\nb\tc"d\\eé'

    def test_unescaping_joins_a_surrogate_pair_into_one_character(self):
        """JSON spells an emoji as two escapes. Decoded apart they are lone surrogates, which do not encode."""
        assert reply._unescape_json_string_body('\\uD83D\\uDE00') == '😀'
        recovered = reply._unescape_json_string_body('all done \\uD83D\\uDE00, shipping')
        assert recovered == 'all done 😀, shipping'
        assert recovered.encode('utf-8').decode('utf-8') == recovered

    def test_unescaping_preserves_a_lone_high_surrogate_as_escape_text(self):
        assert reply._unescape_json_string_body('\\uD83Dx') == '\\uD83Dx'

    def test_unescaping_passes_through_what_it_does_not_recognise(self):
        """A lone backslash is far likelier to be a Windows path than a mistake."""
        assert reply._unescape_json_string_body('C:\\Users\\x') == 'C:\\Users\\x'

    @pytest.mark.parametrize(
        'body', ['bad \\u-001 here', 'bad \\u+1f4 here', 'bad \\u 041 here', 'bad \\u1_00 here', 'cut \\u00']
    )
    def test_unescaping_takes_only_four_hex_digits_as_a_unicode_escape(self, body):
        """`int(x, 16)` also takes a sign, a space and an underscore: one raised, the others decoded a character nobody wrote."""
        assert reply._unescape_json_string_body(body) == body

    def test_unescaping_keeps_a_high_surrogate_apart_from_a_malformed_low_one(self):
        assert reply._unescape_json_string_body('\\uD83D\\u+E00') == '\\uD83D\\u+E00'

    def test_a_malformed_unicode_escape_does_not_end_the_turn(self):
        """It raised out of the parser, so the turn failed on the first reply with no retry."""
        ask, feedback = scripted('{"type":"final","content":"a "b" \\u-001 c"}')

        assert reply._run_model_turn(ask).content == 'a "b" \\u-001 c'
        assert len(feedback) == 1


# ---------------------------------------------------------------------------
# The retry hint
# ---------------------------------------------------------------------------


class TestRetryHint:
    def test_names_the_break_and_points_a_broken_answer_at_the_sentinel(self):
        hint = reply._parse_failure_hint(BROKEN_FINAL)

        assert 'not valid JSON' in hint
        assert 'at character' in hint
        # It quotes the text at the break, so the model can see the stray quote.
        assert 'EARTH' in hint
        assert f'send the answer as {FINAL_SENTINEL}' in hint

    @pytest.mark.parametrize('raw', ['', '   ', None])
    def test_an_empty_reply_is_called_empty(self, raw):
        assert reply._parse_failure_hint(raw) == 'Your last output was empty.'

    def test_a_bare_json_object_is_asked_for_after_the_sentinel(self):
        """#3367 case D. The hint used to say only that the shape was wrong, with no way to answer."""
        hint = reply._parse_failure_hint(ANSWER_JSON)

        assert 'not one of the allowed shapes' in hint
        assert f'write {FINAL_SENTINEL} followed by the JSON' in hint
        # It may have been a tool call that lost its "type", so that way out is named too.
        assert '{"type":"tool_call","name":"server.tool","args":{...}}' in hint

    @pytest.mark.parametrize('raw', ['{"type":"task","description":"..."}', '[' + ANSWER_JSON + ']'])
    def test_other_valid_json_gets_the_same_two_ways_out(self, raw):
        hint = reply._parse_failure_hint(raw)

        assert 'not one of the allowed shapes' in hint
        assert FINAL_SENTINEL in hint

    def test_a_broken_tool_call_is_told_to_repair_the_tool_call(self):
        """The hint must not talk the model out of the work: no sentinel for a broken call."""
        hint = reply._parse_failure_hint(BROKEN_TOOL_CALL)

        assert 'Generate the required tool call' in hint
        assert 'do not answer in prose' in hint
        assert FINAL_SENTINEL not in hint

    def test_a_broken_tool_call_with_a_bare_marker_after_it_is_told_to_repair_the_call(self):
        """The parser does not read a marker stacked onto a call, so the hint must not ask for an answer after it."""
        hint = reply._parse_failure_hint(BROKEN_TOOL_CALL + '\n' + FINAL_SENTINEL)

        assert 'not valid JSON' in hint
        assert hint.endswith(
            'Generate the required tool call from the task and tool schema as one valid JSON object; do not answer in prose.'
        )
        assert 'Write the answer after' not in hint

    @pytest.mark.parametrize(
        'text, kind',
        [
            # The type the envelope opens with, whatever its members hold.
            ('{"type":"final","content":{"type":"tool_call","note":"unfin', 'final'),
            ('Sure.\n{"type":"tool_call","name":"t","args":{"a":"x "y" z"}}', 'tool_call'),
            # Read as JSON would read it, escapes included.
            ('{"type":"tool\\u005fcall","name":"t","args":{"a":"x "y" z"}}', 'tool_call'),
            ('{"type":"fin\\u0061l","content":"cut off', 'final'),
            # A type that is no envelope's is none, whatever is nested under it.
            ('{"type":"task","args":{"type":"tool_call","x":"a "b" c"}}', None),
            # Text that mentions a type with no object opening on it is not an attempt.
            ('Answer: set "type": "final" in config.', None),
            # The object's own type, wherever it comes among its members.
            ('{"content":{"type":"tool_call","note":"x"},"type":"final"', 'final'),
            ('{"args":{"type":"final","note":"a "quoted" word"},"type":"tool_call","name":"crm.create"}', 'tool_call'),
            ('{"name":"crm.create","type":"tool_call","args":{"type":"final","note":"a "quoted" word"}}', 'tool_call'),
            # A tool call written as a JavaScript object, its keys unquoted, is one by the type right after its brace.
            ('{type: "tool_call", name: "crm.get_deal", args: {deal_id: 42}}', 'tool_call'),
            ('{type: "tool_call", name: "crm.get_deal"}', 'tool_call'),
            # With no type it is an object literal, as code has them.
            ('{name: "crm.get_deal", args: {deal_id: 42}}', None),
            # An unquoted type that names no envelope, and the word args in a sentence, are prose.
            ('{type: "object"} is the JSON Schema root.', None),
            ('{type: "final", content: "cut off', 'final'),
            ('{x} is a set. Its args: none.', None),
            ('{x} is a set, args: none.', None),
            # An unquoted type that is no tool call's does not hide the broken call after it.
            (
                'The field is {type: "string"}. Calling: {"type":"tool_call","name":"t","args":{"a":"x "y" z"}}',
                'tool_call',
            ),
            # A `final` named in an object inside a sentence is prose.
            ('Set msg = {"type": "final", "content": text} before returning.', None),
            # A broken tool call is one in any member order, on a line of its own or inside a sentence.
            ('Calling: {"name":"crm.create","args":{"note":"a "b" c"},"type":"tool_call"}', 'tool_call'),
            ('Calling: {"name":"crm.create","args":{"note":"a "b" c"}}', 'tool_call'),
            # A stray quote puts the reading out of step, and the types named after it decide: a tool call's first.
            ('{"args":{"type":"final","note":"5" tall"},"type":"tool_call","name":"crm.create"}', 'tool_call'),
            ('{"content":"5" tall","type":"final"}', 'final'),
            # A name that is no string is not a tool's, with arguments or without.
            ('{"name": {"first": "x"}, "args": ["a "b" c"]}', None),
            ('Sure.\n{"name":"crm.create","type":"tool_call","args":{"note":"a "b" c"}}', 'tool_call'),
            ('{"name":"crm.create","args":{"note":"a "quoted" word"}}', 'tool_call'),
            (PRETTY_BROKEN_TOOL_CALL, 'tool_call'),
            # A broken tool call is one wherever it sits, and in a Python dict's quotes too.
            ('Creating it now: {"type":"tool_call","name":"t","args":{"a":"x "y" z"}}', 'tool_call'),
            ("{'type': 'tool_call', 'name': 'crm.create', 'args': {'name': 'Acme'}}", 'tool_call'),
            ("{'name': 'crm.create', 'args': {'name': 'Acme'}, 'type': 'tool_call'}", None),
            # The first object the reply parses to counts wherever it sits, as the parser reads it.
            ('The format is {"type":"final","content":"x"} ok', 'final'),
            # A broken `final` that ends its line stands, and a call behind a brace that opens nothing is still one.
            ('Our API returns {\n  "type": "final",\n  "content": "text",\n}', 'final'),
            ('{\n{"type":"tool_call","name":"t","args":{"a":"x "y" z"}}', 'tool_call'),
            # An object that parses apart from a literal JSON does not have is read by what it holds, not by what follows it.
            ('The config {"name": "demo", "debug": tru} is wrong. Set "args": [] and "type": "tool_call".', None),
            # With a word before it on its line, an object in JavaScript's or Python's spelling is code.
            ('Creating it: {type: "tool_call", name: "crm.get_deal", args: {deal_id: 42}}', None),
            ("call = {'type': 'tool_call', 'name': 'search', 'args': {}}", None),
            # A call that parses and is quoted after another object is prose.
            ('Plan: {"note": 1} then {"type":"tool\\u005fcall","name":"t","args":{}} runs.', None),
            # Arguments with no name are not a tool call's, and neither are unquoted keys inside a sentence.
            ('{\n  "cmd": "run",\n  "args": ["--fast"]  // fast\n}', None),
            ('{name: "build", args: ["--fast"]}', None),
            ('Call run({name: "build", args: {fast: true}}) to start.', None),
            # A broken `final` on a line of its own after braces that are prose.
            ('Use {curly} here.\n{"content":"a "b" c","type":"final"', 'final'),
            # An envelope on a later line is, when the first object is none.
            ('{"note":"first"}\n{"type":"tool_call","name":"t","args":{"a":"x "y" z"}}', 'tool_call'),
            ('{"content":"abc', None),
            ('no braces at all', None),
            # The type right after the brace, with its colon missing or miswritten, or its key in curly
            # quotes or without its closing quote. Also after a word on its line.
            ('{"type" "tool_call", "name": "search", "args": {"q": "weather"}}', 'tool_call'),
            ('Action: {"type"="tool_call","name":"s","args":{}}', 'tool_call'),
            ('{"type"："tool_calls","calls":[]}', 'tool_calls'),
            ('Action: {“type”: "tool_call","name":"s","args":{}}', 'tool_call'),
            ('{"type: "tool_call","name":"s","args":{}}', 'tool_call'),
            # A key that lost its colon, or a comment's quoted word, before the type.
            ('Action: {"name" "s","type":"tool_call","args":{"q":"a"}}', 'tool_call'),
            ('{ /* "search" */ "type":"tool_call","name":"s","args":{"q":"a"}}', 'tool_call'),
            # A name and arguments with no type, on a line of their own after a brace that is prose.
            ('Use {curly} here.\n{"name":"crm.create","args":{}}', 'tool_call'),
            # Its own type decides, whatever is nested in its members.
            ('{"args":[{"type":"final"}],"type":"tool_calls","calls":[{"name":"a "b""}]}', 'tool_calls'),
            ('{"note":"x "y z","args":{"type":"tool_call"', 'tool_call'),
            (
                '{"note":"x "y z","content":{"type":"final"},"args":{"type":"tool_call"},"calls":{"type":"tool_calls"',
                'tool_call',
            ),
        ],
    )
    def test_what_an_unparsed_reply_set_out_to_be(self, text, kind):
        assert reply._attempted_kind(text) == kind

    @pytest.mark.parametrize(
        'text, members, rest, stray',
        [
            # Its own members, with the values that are strings. Not the ones nested in a value.
            (
                '{"type":"tool_call","name":"t","args":{"type":"final","n":[1]}} and more',
                {'type': 'tool_call', 'name': 't', 'args': None},
                ' and more',
                False,
            ),
            # Read as JSON reads them, escapes included.
            ('{"ty\\u0070e":"tool\\u005fcall","name":"a\\"b"}', {'type': 'tool_call', 'name': 'a"b'}, '', False),
            # A literal JSON does not have, comments and a trailing comma put no quote out of place.
            (
                '{ // a job\n"name": "demo", // its name\n"on": True, /* yes */ "z": "q" // end\n,}',
                {'name': 'demo', 'on': None, 'z': 'q'},
                '',
                False,
            ),
            # An object that never closes has no end. A string that never ends takes the rest with it.
            ('{"a": {"b": 1}', {'a': None}, None, False),
            ('{"a": 1, "b": "cut off }', {'a': None, 'b': None}, None, False),
            # A quote out of place: a string that is not followed, or not preceded, by what JSON has there.
            ('{"name": "crm."create", "args": {}}', {'name': 'crm.'}, None, True),
            ('{"args": {"src": "print("}")"}, "name": "x"}', {'args': None}, ', "name": "x"}', True),
            ('{"a": {"note": "5" tall"}, "b": 1}', {'a': None}, None, True),
            ('{"a": "b" c}', {'a': 'b'}, '', True),
            # A comment that never ends is cut off where it starts, like one that does.
            ('{"a": 1, /* never closed\n"b": 2}', {'a': None, 'b': None}, '', False),
            # A brace that is not followed by a key opens no object, and nothing more of it is read.
            ('{x} is a set', {}, ' is a set', False),
            ('{12" pipe} and {"type":"tool_call"}', {}, None, True),
            ('{\n{"type":"tool_call","name":"s","args":{}}', {}, None, False),
            ('{name: "x", args: {}}', {}, None, False),
            ('{"a", "b"}', {}, '', True),
            # A key that lost its colon is still the opening of an object. More than three strings are not.
            ('{"type" "tool_call", "name": "s", "args": {}}', {'name': 's', 'args': None}, '', True),
            ('{"a" "b" "c" "d" "name": "s"}', {}, None, False),
        ],
    )
    def test_the_members_an_object_carries_itself(self, text, members, rest, stray):
        """How an object that does not parse is still read, and what is no object at all."""
        found, end, out_of_place = reply._own_members(text, 0)

        assert found == members
        assert (None if end is None else text[end:]) == rest
        assert out_of_place is stray

    def test_a_cut_off_final_is_asked_for_as_an_answer_whatever_its_content_names(self):
        """The envelope's own type decides the hint. A tool call named inside the content asked for a tool call."""
        hint = reply._parse_failure_hint('FINAL>>> {"type":"final","content":{"type":"tool_call","note":"unfinished')

        assert 'Generate the required tool call' not in hint
        assert hint.endswith(f'send the answer as {FINAL_SENTINEL} followed by plain text.')

    def test_a_broken_envelope_after_the_marker_is_diagnosed_without_the_marker(self):
        """The envelope is what did not parse. Diagnosed with the marker in front of it, it broke at character 0."""
        hint = reply._parse_failure_hint(FINAL_SENTINEL + ' {"type":"final","content":"a "b" c"} Hope that helps!')

        assert 'at character 0' not in hint
        assert '"content":"a "b' in hint

    @pytest.mark.parametrize(
        'raw',
        ['{"name":"crm.create","args":{}}', 'Here is the result:\n{"name":"crm.create","args":{}}'],
    )
    def test_a_tool_call_that_lost_its_type_is_asked_for_again_as_a_tool_call(self, raw):
        """Pointing it at the sentinel would trade the work for a sentence about it."""
        hint = reply._parse_failure_hint(raw)

        assert 'not one of the allowed shapes' in hint
        assert hint.endswith(
            'Generate the required tool call from the task and tool schema as {"type":"tool_call","name":"server.tool","args":{...}}.'
        )
        assert FINAL_SENTINEL not in hint

    def test_a_claim_after_a_tool_call_that_lost_its_type_is_not_asked_for_as_an_answer(self):
        """Followed, that hint would deliver the claim on the next attempt."""
        hint = reply._parse_failure_hint('Calling it:\n{"name":"crm.create","args":{}}\nFINAL>>> Created.')

        assert hint.endswith('do not answer in prose.')
        assert 'send the answer as' not in hint

    def test_a_tool_call_of_the_wrong_shape_is_asked_for_again_as_a_tool_call(self):
        """Valid JSON, but it names no tool."""
        hint = reply._parse_failure_hint('{"type":"tool_call","name":"","args":{}}')

        assert 'not one of the allowed shapes' in hint
        assert 'Generate the required tool call from the task and tool schema as {"type":"tool_call"' in hint
        assert FINAL_SENTINEL not in hint

    @pytest.mark.parametrize(
        'raw', [PARALLEL_CALLS, '{"type":"tool_calls","calls":[]}', '{"calls":[],"type":"tool_calls"}']
    )
    def test_several_calls_in_one_reply_are_asked_for_one_at_a_time(self, raw):
        hint = reply._parse_failure_hint(raw)

        assert 'Send one tool call per reply, as {"type":"tool_call"' in hint
        assert FINAL_SENTINEL not in hint

    def test_a_bare_marker_line_at_the_end_of_a_cut_off_answer_is_not_asked_for_text_after_it(self):
        """The parser reads that line as part of the answer. Asking for text after it would lose what came before."""
        hint = reply._parse_failure_hint('{"type":"final","content":"Here is the long answer so far\n' + FINAL_SENTINEL)

        assert 'with no answer after it' not in hint
        assert 'not valid JSON' in hint
        assert hint.endswith(f'send the answer as {FINAL_SENTINEL} followed by plain text.')

    @pytest.mark.parametrize('raw', [FINAL_SENTINEL, 'Let me think.\n' + FINAL_SENTINEL + '  '])
    def test_a_sentinel_with_nothing_after_it_is_named_as_that(self, raw):
        """Not as invalid JSON at character 0, which tells a model that did write the marker nothing."""
        assert reply._parse_failure_hint(raw) == (
            f'Your last output ended at {FINAL_SENTINEL} with no answer after it. Write the answer after {FINAL_SENTINEL}.'
        )

    @pytest.mark.parametrize(
        'raw',
        [
            '```json\n' + BROKEN_TOOL_CALL + '\n```',
            'Sure, let me do that.\n' + BROKEN_TOOL_CALL,
            'Creating it now: ' + BROKEN_TOOL_CALL,
        ],
    )
    def test_the_break_is_found_inside_a_fence_and_after_a_line_of_prose(self, raw):
        """The position is the one in the JSON, where the model can see the stray quote, not character 0."""
        hint = reply._parse_failure_hint(raw)

        assert hint == reply._parse_failure_hint(BROKEN_TOOL_CALL)
        assert 'at character 67' in hint
        assert '"content":"a "quoted' in hint

    @pytest.mark.parametrize('raw', [CUT_OFF_FINAL, 'I think the answer is "42", probably.'])
    def test_a_cut_off_answer_and_plain_prose_are_pointed_at_the_sentinel(self, raw):
        assert FINAL_SENTINEL in reply._parse_failure_hint(raw)

    @pytest.mark.parametrize(
        'text, lost',
        [
            ('{"name":"crm.create","args":{}}', True),
            ('Sure.\n{"name":"crm.create","args":{"note":"a "quoted" word"}}', True),
            # A name written with a JSON escape is still a name.
            ('{"name":"crm.\\u0063reate","args":{"note":"a "quoted" word"}}', True),
            ('{"n\\u0061me":"crm.create","args":{"note":"a "quoted" word"}}', True),
            # With its type it is an ordinary tool call, and a name alone is not a call.
            ('{"type":"tool_call","name":"crm.create","args":{}}', False),
            ('{"args":{"note":"a "quoted" word"},"type":"tool_call","name":"crm.create"}', False),
            ('{"name":"crm.create"}', False),
            ('{"name":{"first":"x"},"args":{}}', False),
            # Members nested in a value are not the object's own.
            ('{"answer":{"name":"crm.create","args":{}},"note":"a "quoted" word"}', False),
        ],
    )
    def test_a_tool_call_that_lost_its_type_is_told_by_its_own_members(self, text, lost):
        assert reply._tool_call_without_type(text) is lost

    def test_a_broken_tool_call_stays_one_when_final_is_named_first(self):
        """A "type":"final" inside the arguments, ahead of the envelope's own type, does not turn the call into an answer."""
        raw = '{"args":{"type":"final","note":"a "quoted" word"},"type":"tool_call","name":"crm.create"}'

        hint = reply._parse_failure_hint(raw)

        assert 'Generate the required tool call' in hint
        assert FINAL_SENTINEL not in hint


def test_an_envelope_is_recognised_inside_a_markdown_fence():
    assert reply._looks_like_envelope('```json\n{"type":"tool_call"')
    assert reply._looks_like_envelope('  {"type":"tool_calls"')
    assert not reply._looks_like_envelope('I could not do that.')
    assert not reply._looks_like_envelope('{curly} braces are used in sets.')
    assert not reply._looks_like_envelope('{"a", "b"} is a set literal in Python.')
    assert reply._looks_like_envelope('{}')
    assert reply._looks_like_envelope("{'type': 'tool_call'}")
    assert reply._looks_like_envelope('{"customer\'s name": "Acme"}')
    assert not reply._looks_like_envelope('{a: 1} is an object literal in JavaScript.')
    assert not reply._looks_like_envelope('{name: value} pairs are written like this.')
    assert not reply._looks_like_envelope('[' + ANSWER_JSON + ']')
    assert not reply._looks_like_envelope('')
    assert not reply._looks_like_envelope(None)


# ---------------------------------------------------------------------------
# One model turn: the retry loop and what it ends on
# ---------------------------------------------------------------------------


@pytest.mark.parametrize('prefix, suffix', [('', ''), ('Working.\n', ''), ('Calling: ', ''), ('```json\n', '\n```')])
@pytest.mark.parametrize(
    'broken',
    [
        '{"name: "crm.get_deal", "type":"tool_call", "args":{"deal_id":42}}',
        '{name": "crm.get_deal", "type":"tool_call", "args":{"deal_id":42}}',
        '{""type": "tool_call", "name":"crm.get_deal", "args":{"deal_id":42}}',
        '{"args": "deal_id": 42}, "type":"tool_call", "name":"crm.get_deal"}',
        '{args": {"note":"a \\"quoted\\" word"}, "type":"tool_call", "name":"crm.get_deal"}',
        '{"args: {"note":"a \\"quoted\\" word"}, "type":"tool_call", "name":"crm.get_deal"}',
    ],
)
def test_a_damaged_first_key_or_early_closing_cannot_turn_a_call_into_a_claim(broken, prefix, suffix):
    """The adapter requests the same call again, then either run the repaired call or fail without its claim."""
    raw = prefix + broken + suffix + '\nFINAL>>> Deal 42 is won.'
    assert reply._parse_tool_call_envelope(raw) is None
    ask, feedback = scripted(raw)
    with pytest.raises(ValueError, match='No valid tool call or final answer after 3 attempts'):
        reply._run_model_turn(ask)
    assert len(feedback) == 3
    assert 'Generate the required tool call' in feedback[1]
    repaired = '{"type":"tool_call","name":"crm.get_deal","args":{"deal_id":42}}'
    ask, feedback = scripted(raw, repaired)
    turn = reply._run_model_turn(ask)
    assert turn.content == ''
    assert [(call['name'], call['args']) for call in turn.tool_calls] == [('crm.get_deal', {'deal_id': 42})]
    assert len(feedback) == 2


@pytest.mark.parametrize('raw', ['{type: "final", content: "Answer"}', "{'type': 'final', 'content': 'Answer'}"])
@pytest.mark.parametrize(
    'prefix, suffix', [('', ''), ('```json\n', '\n```'), ('FINAL>>> ', ''), ('', '\nFINAL>>> Done.')]
)
def test_a_final_with_unquoted_or_single_quoted_keys_is_retried(raw, prefix, suffix):
    """An invalid final is protocol, including after a marker; its raw envelope is not prose to deliver."""
    ask, feedback = scripted(prefix + raw + suffix)
    with pytest.raises(ValueError, match='No valid tool call or final answer after 3 attempts'):
        reply._run_model_turn(ask)
    assert len(feedback) == 3


class TestRunModelTurn:
    def test_a_reply_that_parses_costs_one_call(self):
        ask, feedback = scripted(FINAL_SENTINEL + 'Done.')

        assert answer_of(reply._run_model_turn(ask)) == 'Done.'
        assert feedback == ['']

    def test_a_salvaged_answer_costs_one_call(self):
        """#3367 cases A, E and F took three calls and then gave up."""
        ask, feedback = scripted('{"type":"final","content":"' + ANSWER_JSON + '"}')

        assert reply._run_model_turn(ask).content == ANSWER_JSON
        assert len(feedback) == 1

    def test_the_second_attempt_can_follow_the_first_hint(self):
        """A broken tool call, the hint, the same call repaired: the turn ends in the call, in two attempts."""
        ask, feedback = scripted(BROKEN_TOOL_CALL, REPAIRED_TOOL_CALL)

        turn = reply._run_model_turn(ask)

        assert turn.tool_calls[0]['name'] == 'crm.note_create'
        assert turn.tool_calls[0]['args'] == {'content': 'a "quoted" note'}
        assert feedback == ['', '\n\nsystem: ' + reply._parse_failure_hint(BROKEN_TOOL_CALL)]
        assert FINAL_SENTINEL not in feedback[1]

    def test_a_bare_json_answer_recovers_once_the_hint_is_followed(self):
        """#3367 case D with a model that reads the hint: the JSON arrives, after the sentinel, on attempt two."""
        ask, feedback = scripted(ANSWER_JSON, FINAL_SENTINEL + ANSWER_JSON)

        assert reply._run_model_turn(ask).content == ANSWER_JSON
        assert len(feedback) == 2
        assert f'write {FINAL_SENTINEL} followed by the JSON' in feedback[1]

    def test_each_failed_attempt_adds_its_hint(self):
        ask, feedback = scripted('', 'Some prose.', FINAL_SENTINEL + 'Done.')

        assert reply._run_model_turn(ask).content == 'Done.'
        assert feedback[1] == '\n\nsystem: Your last output was empty.'
        assert feedback[2] == feedback[1] + '\n\nsystem: ' + reply._parse_failure_hint('Some prose.')

    def test_a_reply_is_read_without_its_surrounding_whitespace(self):
        """After the marker everything is the answer, so this is where the trimming of the reply shows."""
        ask, _ = scripted('\n  FINAL>>> Done.  \n')

        assert reply._run_model_turn(ask).content == 'Done.'

    def test_an_envelope_kept_after_the_hint_is_followed_is_still_unwrapped(self):
        """Attempt one has text after a broken envelope, so it is retried. Attempt two puts the envelope after the marker."""
        ask, feedback = scripted(
            '{"type":"final","content":"No org named "EARTH" was found."} Hope that helps!',
            'FINAL>>> {"type":"final","content":"No org named \\"EARTH\\" was found."}',
        )

        assert answer_of(reply._run_model_turn(ask)) == 'No org named "EARTH" was found.'
        assert len(feedback) == 2

    @pytest.mark.parametrize(
        'text, said',
        [
            (BROKEN_TOOL_CALL, 'not valid JSON'),
            (ANSWER_JSON, 'not one of the allowed shapes'),
            (CUT_OFF_FINAL, 'Unterminated string'),
            ('{"type":"tool_call","name":""}', 'not one of the allowed shapes'),
            ('', 'The last reply was empty.'),
            (None, 'The last reply was empty.'),
            # A tool call that never parsed is work that never ran, also after a line of prose and before a claim.
            ('Sure, let me do that.\n' + BROKEN_TOOL_CALL, 'not valid JSON'),
            (BROKEN_TOOL_CALL + STACKED_FINAL, 'not valid JSON'),
            ('Sure, let me do that.\n' + BROKEN_TOOL_CALL + STACKED_FINAL, 'not valid JSON'),
            # A cut-off answer is not prose to deliver either, with or without a line before it.
            ('Here is the answer:\n' + CUT_OFF_FINAL, 'Unterminated string'),
            # An envelope on a line of its own counts, also when the first object parses and is no envelope.
            ('Two objects.\n{"note":"first"}\n' + BROKEN_TOOL_CALL, 'not valid JSON'),
            # A member after the content: where the answer ended cannot be told, so it is not recovered.
            ('{"type":"final","content":"a "b"","note":"z"}', 'not valid JSON'),
            # An envelope the reply parses to counts wherever it sits. The error names the text after it.
            ('I will call {"name":"","type":"tool_call"} now.', 'not valid JSON'),
            # A broken tool call inside a sentence, and one written as a Python dict, are work that never ran.
            ('Creating it now: ' + BROKEN_TOOL_CALL, 'not valid JSON'),
            ("{'type': 'tool_call', 'name': 'crm.create', 'args': {'name': 'Acme'}}", 'not valid JSON'),
            # A tool call that lost its "type" is work that never ran, and a claim after it is not an answer.
            ('Here is the result:\n{"name":"crm.create","args":{}}', 'named a tool and its arguments with no "type"'),
            (
                'Calling it:\n{"name":"crm.create","args":{}}\nFINAL>>> Created.',
                'named a tool and its arguments with no "type"',
            ),
            (
                'Here is the result:\n{"name":"crm.create","args":{}}\nFINAL>>> Created.',
                'named a tool and its arguments with no "type"',
            ),
            # A tool call whose type lost its colon is work that never ran, with a claim after it or not.
            (
                '{"type" "tool_call", "name": "search", "args": {"q": "weather"}}',
                'named a tool and its arguments with no "type"',
            ),
            (
                '{"type" "tool_call", "name": "search", "args": {"q": "weather"}}\nFINAL>>> It is sunny.',
                'named a tool and its arguments with no "type"',
            ),
            ('Sure.\n{"name":"crm.create","type":"tool_call","args":{"note":"a "b" c"}}', 'not valid JSON'),
            # A tool call with unquoted keys is work that never ran, not prose.
            ('{type: "tool_call", name: "crm.get_deal", args: {deal_id: 42}}', 'not valid JSON'),
            ('{type: "tool_call", name: "crm.get_deal"}', 'not valid JSON'),
            # A reply that was cut off right after its brace is not prose.
            ('{', 'not valid JSON'),
            ('```json\n{', 'not valid JSON'),
            # A pretty-printed broken tool call is work that never ran, and the claim after it is not an answer.
            (PRETTY_BROKEN_TOOL_CALL + '\nFINAL>>> Created.', 'not valid JSON'),
            # A key with an apostrophe in it is still a key.
            ('{"customer\'s name": "Acme"}', 'not one of the allowed shapes'),
            # The marker alone is protocol text, not an answer.
            (FINAL_SENTINEL, f'ended at {FINAL_SENTINEL} with no answer after it'),
            ('Let me think.\n' + FINAL_SENTINEL, f'ended at {FINAL_SENTINEL} with no answer after it'),
        ],
    )
    def test_a_turn_with_nothing_to_deliver_fails(self, text, said):
        """
        The run then ends as an error. A broken tool call (work that never ran), a bare object, a
        cut-off answer and an empty reply are not answers, and neither is a sentence about giving up.
        """
        ask, feedback = scripted(text)

        with pytest.raises(ValueError, match='No valid tool call or final answer after 3 attempts') as failure:
            reply._run_model_turn(ask)

        message = str(failure.value)
        assert said in message
        assert len(feedback) == reply._MAX_ATTEMPTS == 3
        # The error is read by a person, or by a parent agent's model as a tool result. It says what
        # was wrong and carries none of the instructions written for this model.
        assert 'The last reply ' in message
        for instruction in ('Your last output', 'Send ', 'Do not retype', 'To call a tool', 'Write the answer'):
            assert instruction not in message
        # It is logged and returned to the caller, so it quotes nothing of the reply either.
        assert 'It broke here' not in message

    @pytest.mark.parametrize(
        'text, asked_for, said',
        [
            (
                'Sure, creating it now.\n'
                '{"type":"tool\\u005fcall","name":"crm.create","args":{"note":"a "quoted" word"}}',
                'Generate the required tool call',
                'not valid JSON',
            ),
            (
                'Here is the answer:\n{"type":"fin\\u0061l","content":"Acme reported revenue of 12',
                f'send the answer as {FINAL_SENTINEL} followed by plain text',
                'Unterminated string',
            ),
        ],
    )
    def test_an_envelope_whose_type_is_spelled_with_an_escape_is_not_prose_to_deliver(self, text, asked_for, said):
        """
        Each hint took the reply for the envelope it is: the call was asked for again, the answer was
        asked for after the marker. The third copy fails the turn like the plain spelling does.
        """
        ask, feedback = scripted(text)

        with pytest.raises(ValueError, match='No valid tool call or final answer after 3 attempts') as failure:
            reply._run_model_turn(ask)

        assert said in str(failure.value)
        assert len(feedback) == reply._MAX_ATTEMPTS == 3
        assert feedback[2].count(asked_for) == 2

    def test_the_text_around_the_break_goes_to_the_model_and_not_into_the_error(self):
        ask, feedback = scripted('{"type":"final","content":"Card 4111 belongs to Jane Roe, and')

        with pytest.raises(ValueError) as failure:
            reply._run_model_turn(ask)

        assert 'Card 4111' in feedback[1]
        assert 'Card 4111' not in str(failure.value)
        assert 'Unterminated string starting at, at character 26.' in str(failure.value)

    def test_the_last_reply_decides_what_an_unparsed_turn_ends_on(self):
        """Readable prose on the earlier attempts does not rescue a turn whose last reply is empty."""
        ask, _ = scripted('Some prose.', 'Some prose.', '')

        with pytest.raises(ValueError, match='The last reply was empty.'):
            reply._run_model_turn(ask)

    def test_a_cut_off_envelope_with_a_marker_line_in_it_is_retried_and_then_fails(self):
        """Three attempts, then an error. The text after the marker line is never the answer."""
        ask, feedback = scripted('{"type":"final","content":"Example:\nFINAL>>> partial')

        with pytest.raises(ValueError, match='No valid tool call or final answer after 3 attempts'):
            reply._run_model_turn(ask)
        assert len(feedback) == 3

    def test_a_reply_whose_envelope_may_have_closed_is_answered_on_the_retry(self):
        ask, feedback = scripted(
            '{"type":"final","content":"an "old" one"} Done.\nFINAL>>> {"company":"Acme"}',
            'FINAL>>> {"company":"Acme"}',
        )

        assert answer_of(reply._run_model_turn(ask)) == '{"company":"Acme"}'
        assert len(feedback) == 2

    def test_a_cut_off_envelope_after_the_marker_is_retried_and_then_fails(self):
        ask, feedback = scripted('FINAL>>> {"type":"final","content":"Acme reported revenue of 12')

        with pytest.raises(ValueError, match='Unterminated string'):
            reply._run_model_turn(ask)
        assert len(feedback) == 3
        assert f'send the answer as {FINAL_SENTINEL} followed by plain text' in feedback[1]

    def test_a_stacked_final_does_not_replace_the_tool_call_it_follows(self):
        ask, feedback = scripted(TOOL_CALL + STACKED_FINAL)

        assert reply._run_model_turn(ask).tool_calls[0]['name'] == 'crm.create'
        assert len(feedback) == 1

    @pytest.mark.parametrize(
        'text',
        [
            'I could not find that organization.',
            '[' + ANSWER_JSON + ']',
            # Prose with a JSON object in it or after it is still something a person can read.
            'Here is the JSON you asked for:\n' + ANSWER_JSON,
            'The config is {"debug": true} by default, and that is fine.',
            'The tool is {"name":"crm.create"} and it takes no arguments.',
            # Prose that starts with a brace, mentions a type, or shows an object with no type is still prose.
            '{curly} braces are used in sets.',
            '{"a", "b"} is a set literal in Python.',
            '{a: 1} is an object literal in JavaScript.',
            '{name: value} pairs are written like this.',
            '{type: "object"} is the JSON Schema root.',
            '{x} is a set. Its args: none.',
            '{x} is a set, args: none.',
            'Answer: set "type": "final" in config.',
            "Set msg = {'type': 'final', 'content': text} before returning.",
        ],
    )
    def test_prose_that_skipped_the_sentinel_is_still_the_answer(self, text):
        """#3367 cases G and H. The model said something readable, so it is delivered once the retries are spent."""
        ask, feedback = scripted(text)

        assert answer_of(reply._run_model_turn(ask)) == text
        assert len(feedback) == 3

    def test_several_calls_in_one_reply_never_run(self):
        ask, feedback = scripted(PARALLEL_CALLS)
        with pytest.raises(ValueError, match='not one of the allowed shapes'):
            reply._run_model_turn(ask)
        assert len(feedback) == 3

    def test_a_final_with_a_member_after_its_content_is_answered_on_the_retry(self):
        ask, feedback = scripted('{"type":"final","content":"a "b"","note":"z"}', 'FINAL>>> a "b"')

        assert answer_of(reply._run_model_turn(ask)) == 'a "b"'
        assert len(feedback) == 2
        assert f'send the answer as {FINAL_SENTINEL}' in feedback[1]

    def test_a_marker_after_an_envelope_that_closed_costs_one_call(self):
        ask, feedback = scripted('{"type":"final","content":"old"}\nFINAL>>> {"company":"Acme"}')

        assert answer_of(reply._run_model_turn(ask)) == '{"company":"Acme"}'
        assert len(feedback) == 1

    def test_a_tool_call_that_lost_its_type_runs_once_the_hint_is_followed(self):
        """The claim stacked onto it is not delivered. The hint asks for the call, and the repaired call is the turn."""
        ask, feedback = scripted(
            'Here is the result:\n{"name":"crm.create","args":{"name":"Acme"}}\nFINAL>>> Created.',
            TOOL_CALL,
        )

        turn = reply._run_model_turn(ask)

        assert [(c['name'], c['args']) for c in turn.tool_calls] == [('crm.create', {'name': 'Acme'})]
        assert len(feedback) == 2
        assert FINAL_SENTINEL not in feedback[1].split('It broke here')[0]


@pytest.mark.parametrize(
    'make_reply, count',
    [
        pytest.param(lambda n: '{' * n, 5000, id='braces_that_open_nothing'),
        pytest.param(lambda n: '{"a":\n' * n, 9000, id='objects_that_never_close'),
        pytest.param(lambda n: '{"a": x}\n' * n, 30000, id='objects_that_do_not_parse'),
        pytest.param(lambda n: '{"a": "b" c}\n' * n, 12000, id='objects_with_a_quote_out_of_place'),
        pytest.param(
            lambda n: ('{"a": "' + 'x' * 4000 + '",\n"b":\n') * n + '1' + '}' * n,
            400,
            id='objects_inside_each_other',
        ),
        pytest.param(
            lambda n: FINAL_SENTINEL + ' ```python\n' + ' ' * n + 'x = 1', 60000, id='a_fence_that_never_closes'
        ),
        pytest.param(lambda n: '{"a": 1, ' + '/* ' * n + '\n"b": 2}', 20000, id='comments_that_never_close'),
        pytest.param(
            lambda n: '{"type":"final","content":"a "b" c' + '"}{"k":["x' * n + '"}',
            4000,
            id='objects_after_closings',
        ),
    ],
)
def test_a_long_reply_is_read_in_linear_time(make_reply, count):
    def read(raw):
        ask, _feedback = scripted(raw)
        try:
            reply._run_model_turn(ask)
        except ValueError:
            pass

    assert_linear_time(read, make_reply(count // 4), make_reply(count))


@pytest.mark.parametrize('prefix', ['Sets look like {1, 2}.\n', 'Example: {"x": 1}\n', '{curly} braces.\n'])
@pytest.mark.parametrize('envelope', [TOOL_CALL, '{"type":"final","content":"done"}'])
def test_a_preamble_object_does_not_hide_a_standing_envelope(prefix, envelope):
    ask, feedback = scripted(prefix + envelope)
    turn = reply._run_model_turn(ask)
    if 'tool_call' in envelope:
        assert [(c['name'], c['args']) for c in turn.tool_calls] == [('crm.create', {'name': 'Acme'})]
    else:
        assert answer_of(turn) == 'done'
    assert len(feedback) == 1


@pytest.mark.parametrize(
    'raw',
    [
        '{"data":' + TOOL_CALL + '}',
        '{' + TOOL_CALL + '}',
        '{\n' + TOOL_CALL + '\n}',
        'Example: {"x":1}\nPreviously ' + TOOL_CALL + ' returned successfully.',
        'Example: {"x":1}\n' + BROKEN_TOOL_CALL + '\n' + TOOL_CALL,
    ],
)
def test_finding_a_later_envelope_does_not_execute_nested_quoted_or_blocked_calls(raw):
    assert parse(raw) is None


@pytest.mark.parametrize('body', [TOOL_CALL, '```json\n' + TOOL_CALL + '\n```', PARALLEL_CALLS])
def test_a_whole_tool_envelope_after_the_marker_is_retried(body):
    raw = FINAL_SENTINEL + '\n' + body
    assert parse(raw) is None
    ask, feedback = scripted(raw)
    with pytest.raises(ValueError):
        reply._run_model_turn(ask)
    assert len(feedback) == 3
    assert 'tool call' in feedback[1]
    assert 'To give this JSON as your answer' not in feedback[1]
    ask, feedback = scripted(raw, TOOL_CALL)
    assert reply._run_model_turn(ask).tool_calls[0]['name'] == 'crm.create'
    assert len(feedback) == 2


def test_the_marker_can_still_introduce_prose_explaining_a_tool_envelope():
    answer = 'For example, use ' + TOOL_CALL + ' to create a record.'
    assert answer_of(parse(FINAL_SENTINEL + '\n' + answer)) == answer


@pytest.mark.parametrize('call', [TOOL_CALL, BROKEN_TOOL_CALL, PARALLEL_CALLS])
def test_a_final_followed_by_pending_work_is_retried(call):
    raw = '{"type":"final","content":"Created."}\n' + call
    ask, feedback = scripted(raw)
    with pytest.raises(ValueError):
        reply._run_model_turn(ask)
    assert len(feedback) == 3
    assert 'do not answer in prose' in feedback[1]


def test_a_final_can_be_followed_by_a_quoted_call_example():
    raw = '{"type":"final","content":"Done."}\nFor example, ' + TOOL_CALL + ' creates a record.'
    assert answer_of(parse(raw)) == 'Done.'


@pytest.mark.parametrize('label', ['json', 'json5', 'c++', 'objective-c'])
def test_fence_labels_with_digits_or_punctuation_allow_final_recovery(label):
    raw = '```' + label + '\n{"type":"final","content":"a "b" c"}\n```'
    assert answer_of(parse(raw)) == 'a "b" c'
    assert parse('FINAL>>>\n' + raw).content == 'a "b" c'
    assert parse('```' + label + '\n' + CUT_OFF_FINAL) is None
    assert parse('FINAL>>>\n```' + label + '\n' + TOOL_CALL + '\n```') is None


@pytest.mark.parametrize('separator', ['\r', '\r\n', '\n'])
def test_a_marker_line_separator_is_removed_once(separator):
    assert answer_of(parse(FINAL_SENTINEL + separator + '  hello')) == '  hello'


def test_a_retry_does_not_pretend_the_model_has_its_previous_full_reply():
    raw = '{"type":"tool_call","name":"crm.create","args":{"note":"' + 'x' * 150 + ' a "b" c"}}'
    ask, feedback = scripted(raw, TOOL_CALL)
    assert reply._run_model_turn(ask).tool_calls
    assert raw not in feedback[1]
    assert 'from the task and tool schema' in feedback[1]
    assert 'SAME' not in feedback[1]


@pytest.mark.parametrize('body', ['{"type":"final","content":"done"}', '[{"name":"example"}]'])
def test_an_inline_fence_without_a_language_keeps_its_json(body):
    raw = 'FINAL>>> ```' + body + '```'
    expected = 'done' if '"type":"final"' in body else '```' + body + '```'
    assert answer_of(parse(raw)) == expected


def test_a_standing_final_that_cannot_be_unwrapped_is_not_delivered_as_protocol():
    ask, feedback = scripted('Example: {"x":1} {"type":"final","content":"done"}')
    with pytest.raises(ValueError):
        reply._run_model_turn(ask)
    assert len(feedback) == 3


class TestNihalFollowup:
    @pytest.mark.parametrize('fence', ['```json', '````json5', '~~~json'])
    @pytest.mark.parametrize('call', [TOOL_CALL, BROKEN_TOOL_CALL, PARALLEL_CALLS])
    def test_a_closed_fenced_example_after_a_final_is_not_pending_work(self, fence, call):
        closing = fence.rstrip('json5')
        raw = '{"type":"final","content":"Here is how to call it."}\n\n' + fence + '\n' + call + '\n' + closing
        ask, feedback = scripted(raw)
        assert answer_of(reply._run_model_turn(ask)) == 'Here is how to call it.'
        assert len(feedback) == 1

    @pytest.mark.parametrize('prefix', ['', '```json\n'])
    def test_an_unclosed_example_fence_does_not_hide_pending_work(self, prefix):
        final = '{"type":"final","content":"Done."}'
        final = prefix + final + ('\n```' if prefix else '')
        ask, feedback = scripted(final + '\n```json\n' + TOOL_CALL)
        with pytest.raises(ValueError):
            reply._run_model_turn(ask)
        assert len(feedback) == 3

    @pytest.mark.parametrize('example', [TOOL_CALL, BROKEN_TOOL_CALL])
    @pytest.mark.parametrize('call', [TOOL_CALL, BROKEN_TOOL_CALL])
    def test_a_fenced_example_does_not_hide_a_later_unfenced_call(self, example, call):
        raw = '{"type":"final","content":"Done."}\n```json\n' + example + '\n```\n' + call
        ask, feedback = scripted(raw)
        with pytest.raises(ValueError):
            reply._run_model_turn(ask)
        assert len(feedback) == 3
        assert 'tool call' in feedback[1]

    @pytest.mark.parametrize('statement', ['return ', 'yield ', 'result = ', 'run('])
    def test_the_first_dict_in_code_is_not_a_typeless_call(self, statement):
        raw = 'Use this helper:\n\ndef f():\n    ' + statement + '{"name": "x", "args": [1]}'
        ask, feedback = scripted(raw)
        assert answer_of(reply._run_model_turn(ask)) == raw
        assert len(feedback) == 3

    @pytest.mark.parametrize('line_end', ['\r', '\n', '\r\n'])
    def test_a_marker_after_a_line_end_delivers_only_its_answer(self, line_end):
        ask, feedback = scripted('Thinking' + line_end + ' \tFINAL>>> ok')
        assert answer_of(reply._run_model_turn(ask)) == 'ok'
        assert len(feedback) == 1

    @pytest.mark.parametrize('prefix', ['I looked at {x}.\n', 'Example: {"x": 1}\n'])
    def test_the_hint_locates_the_broken_envelope_after_a_preamble(self, prefix):
        with pytest.raises(json.JSONDecodeError) as error:
            json.loads(BROKEN_TOOL_CALL)
        hint = reply._parse_failure_hint(prefix + BROKEN_TOOL_CALL)
        assert f'at character {error.value.pos}.' in hint
        assert '{x}' not in hint
        assert 'tool call' in hint

    @pytest.mark.parametrize('escape', [r'\ud800', r'\udfff', r'\uD83D\u0041', r'\ud800\ud800', r'\udc00\ud800'])
    def test_recovered_unpaired_surrogates_can_be_encoded(self, escape):
        raw = '{"type":"final","content":"bad ' + escape + ' "x""}'
        ask, feedback = scripted(raw)
        answer = answer_of(reply._run_model_turn(ask))
        assert answer.encode('utf-8').decode('utf-8') == answer
        assert '\\u' in answer
        assert len(feedback) == 1


class TestCodeDictionariesAndUnicodeFinals:
    @pytest.mark.parametrize(
        'expression',
        ['Calling crm.create({call})', 'Tool call = {call}', 'Action: invoke(crm, {call})', 'return {call}'],
    )
    @pytest.mark.parametrize('claim', ['FINAL>>> Created.', '{"type":"final","content":"Created."}'])
    def test_code_shaped_pending_work_with_a_claim_is_refused(self, expression, claim):
        raw = expression.format(call='{"name":"crm.create","args":{"n":1}}') + '\n' + claim
        ask, feedback = scripted(raw)
        with pytest.raises(ValueError, match='after 3 attempts'):
            reply._run_model_turn(ask)
        assert len(feedback) == 3
        # The repair must request the missing call, never teach the model to drop it for a claim.
        for hint in feedback[1:]:
            assert 'Generate the required tool call' in hint
            assert 'do not answer in prose' in hint
            assert 'send the answer as FINAL>>>' not in hint

    @pytest.mark.parametrize(
        'prefix',
        [
            'client.run("crm", ',
            'client.run("crm", 1, ',
            'client.run(get_name("crm"), ',
            'client.run(")", ',
            "client.run(')', ",
            'client.run(`)`, ',
            r'client.run("quoted \" )", ',
            'const f = () => ',
            'const f = async () => ',
        ],
    )
    def test_later_arguments_and_arrow_function_dictionaries_are_answer_text(self, prefix):
        raw = 'Call it like this:\n\n' + prefix + '{"name": "x", "args": [1]})'
        ask, feedback = scripted(raw)
        assert answer_of(reply._run_model_turn(ask)) == raw
        assert len(feedback) == 3

    @pytest.mark.parametrize(
        'prefix',
        [
            'Calling: ',
            'Calling, ',
            'Calling (crm), ',
            'Calling "(", ',
            "Calling '(', ",
            'Calling `(`, ',
            'Calling ("open, ',
        ],
    )
    def test_prose_and_quoted_parentheses_do_not_hide_typeless_pending_work(self, prefix):
        raw = prefix + '{"name":"crm.create","args":{"name":"Acme"}}' + STACKED_FINAL
        ask, feedback = scripted(raw)
        with pytest.raises(ValueError):
            reply._run_model_turn(ask)
        assert len(feedback) == 3

    @pytest.mark.parametrize('wrapper', ['{}', 'FINAL>>> {}', '```json\n{}\n```', '[{}]'])
    @pytest.mark.parametrize(
        ('content', 'expected'),
        [
            ('bad \ud800', r'bad \ud800'),
            ('bad \udfff', r'bad \udfff'),
            ('\ud800\ud800', r'\ud800\ud800'),
            ('\udc00\ud800', r'\udc00\ud800'),
            ('\ud800A', r'\ud800A'),
            ('\U0001f600 caf\u00e9', '\U0001f600 caf\u00e9'),
            (r'literal \ud800', r'literal \ud800'),
            ({'\ud800': ['\udfff', '\U0001f600']}, '{"\\ud800": ["\\udfff", "\U0001f600"]}'),
        ],
    )
    def test_valid_final_content_always_encodes_as_utf8(self, wrapper, content, expected):
        raw = wrapper.format(json.dumps({'type': 'final', 'content': content}))
        ask, feedback = scripted(raw)
        answer = answer_of(reply._run_model_turn(ask))
        assert answer == expected
        assert answer.encode('utf-8').decode('utf-8') == answer
        assert len(feedback) == 1
