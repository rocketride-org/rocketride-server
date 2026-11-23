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
# Text a model stacks onto a call: an answer about the result of work that has not run yet.
STACKED_FINAL = '\nFINAL>>> I created the Acme record.'


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

    def test_a_broken_tool_call_with_a_final_line_stacked_after_it_is_retried(self):
        """Not delivered as the stacked answer, and the hint asks for the call, not for prose."""
        raw = BROKEN_TOOL_CALL + STACKED_FINAL

        assert parse(raw) is None
        assert reply._parse_failure_hint(raw).endswith(
            'Send the SAME tool call again as one valid JSON object: repair the JSON, do not answer in prose.'
        )

    def test_a_tool_call_after_a_line_of_prose_keeps_its_stacked_final_out_too(self):
        """Prose before a call never stopped the call from running, and a stacked final does not change that."""
        turn = parse('Sure, creating it now.\n' + TOOL_CALL + STACKED_FINAL)

        assert turn.content == ''
        assert turn.tool_calls[0]['name'] == 'crm.create'
        assert parse('Sure, creating it now.\n' + BROKEN_TOOL_CALL + STACKED_FINAL) is None

    def test_prose_with_braces_before_the_sentinel_does_not_take_it_away(self):
        assert parse('Use {curly} braces here.\nFINAL>>> Done.').content == 'Done.'

    @pytest.mark.parametrize(
        'before',
        [
            '{"note": "x"}',
            '{"type":"final","content":"old"}',
            'Thinking about a tool call.',
            # A JSON object that does not parse and was never an envelope.
            '{"note": "a "quoted" word"}',
            # A name alone is not a tool call that lost its type.
            '{"name": "crm.create"}',
        ],
    )
    def test_other_text_before_the_sentinel_does_not_take_it_away(self, before):
        """Only an attempt at a tool-call envelope before the marker keeps the marker from being read."""
        assert parse(before + '\nFINAL>>> Done.').content == 'Done.'

    def test_an_escaped_quote_before_a_marker_line_does_not_close_the_envelope(self):
        """The content is escaped as it should be, apart from its line break. Its own quote and brace close nothing."""
        raw = '{"type":"final","content":"see {\\"k\\":\\"v\\"} and\nFINAL>>> more"}'

        assert parse(raw).content == 'see {"k":"v"} and\nFINAL>>> more'

    def test_a_marker_line_inside_a_final_envelope_is_the_answers_own_text(self):
        """
        The content has literal line breaks and one of its lines starts with the marker. The envelope
        is still open there and closes at the end of the reply, so its content is the answer. Reading
        the sentinel first lost the text before it and delivered the envelope's closing with the rest.
        """
        raw = '{"type":"final","content":"Example:\nFINAL>>> sample"}'

        assert parse(raw).content == 'Example:\nFINAL>>> sample'

    @pytest.mark.parametrize(
        'raw',
        [
            '{"type":"final","content":"Example:\nFINAL>>> partial',
            # The same with content that is an object, and with the members the other way round.
            '{"type":"final","content":{"note":"Example:\nFINAL>>> partial',
            '{"content":{"note":"Example:"},"type":"final","more":"x\nFINAL>>> partial',
            # An escaped quote and a brace in the content close nothing.
            '{"type":"final","content":"see {\\"k\\":\\"v\\"} and\nFINAL>>> partial',
            # A line of prose before the envelope changes nothing.
            'Here is the result:\n{"type":"final","content":"Example:\nFINAL>>> partial',
        ],
    )
    def test_a_marker_line_inside_an_envelope_that_never_closes_is_not_an_answer(self, raw):
        """
        The reply is a cut-off envelope, whatever one of its lines starts with. Reading the marker
        there delivered the tail of a partial answer as a finished one.
        """
        assert parse(raw) is None
        assert reply._salvage_final_content(raw) is None

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

    def test_a_member_after_the_content_is_taken_for_part_of_the_answer(self):
        """Another limit of reading unescaped content, pinned: nothing says where the content ended."""
        raw = '{"type":"final","content":"a "b" c", "confidence": "high"}'

        assert parse(raw).content == 'a "b" c", "confidence": "high'

    def test_a_fenced_envelope_is_recovered_like_a_bare_one(self):
        """Models fence JSON whatever the prompt says. The fence is not part of the answer."""
        raw = '```json\n{"type":"final","content":"No org named "EARTH" was found."}\n```'

        assert answer_of(parse(raw)) == 'No org named "EARTH" was found.'

    def test_a_marker_line_inside_a_fenced_envelope_is_the_answers_own_text(self):
        raw = '```json\n{"type":"final","content":"Example:\nFINAL>>> sample"}\n```'

        assert answer_of(parse(raw)) == 'Example:\nFINAL>>> sample'

    def test_a_fenced_envelope_that_was_cut_off_is_not_salvaged(self):
        raw = '```json\n{"type":"final","content":"Acme reported "revenue" of 12'

        assert reply._salvage_final_content(raw) is None
        assert parse(raw) is None

    @pytest.mark.parametrize('second', ['{"type":"final","content":"second"}', '{"content":"second","type":"final"}'])
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

    def test_unescaping_leaves_a_lone_high_surrogate_alone(self):
        assert reply._unescape_json_string_body('\\uD83Dx') == chr(0xD83D) + 'x'

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
        assert reply._unescape_json_string_body('\\uD83D\\u+E00') == chr(0xD83D) + '\\u+E00'

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

        assert 'SAME tool call again' in hint
        assert 'do not answer in prose' in hint
        assert FINAL_SENTINEL not in hint

    def test_a_broken_tool_call_with_a_bare_marker_after_it_is_told_to_repair_the_call(self):
        """The parser does not read a marker stacked onto a call, so the hint must not ask for an answer after it."""
        hint = reply._parse_failure_hint(BROKEN_TOOL_CALL + '\n' + FINAL_SENTINEL)

        assert 'not valid JSON' in hint
        assert hint.endswith(
            'Send the SAME tool call again as one valid JSON object: repair the JSON, do not answer in prose.'
        )
        assert 'Write the answer after' not in hint

    def test_a_cut_off_final_is_asked_for_as_an_answer_whatever_its_content_names(self):
        """The envelope's own type decides the hint. A tool call named inside the content asked for a tool call."""
        hint = reply._parse_failure_hint('FINAL>>> {"type":"final","content":{"type":"tool_call","note":"unfinished')

        assert 'SAME tool call' not in hint
        assert hint.endswith(f'send the answer as {FINAL_SENTINEL} followed by plain text.')

    @pytest.mark.parametrize(
        'raw',
        ['{"name":"crm.create","args":{}}', 'Here is the result:\n{"name":"crm.create","args":{}}'],
    )
    def test_a_tool_call_that_lost_its_type_is_asked_for_again_as_a_tool_call(self, raw):
        """Pointing it at the sentinel would trade the work for a sentence about it."""
        hint = reply._parse_failure_hint(raw)

        assert 'not one of the allowed shapes' in hint
        assert hint.endswith('Send the tool call again as {"type":"tool_call","name":"server.tool","args":{...}}.')
        assert FINAL_SENTINEL not in hint

    @pytest.mark.parametrize(
        'text, kind',
        [
            # The envelope's own type, whatever its members hold and in whatever order they come.
            ('{"type":"final","content":{"type":"tool_call","note":"unfin', 'final'),
            ('{"content":{"type":"tool_call","note":"x"},"type":"final"', 'final'),
            ('{"args":{"type":"final","note":"a "quoted" word"},"type":"tool_call","name":"crm.create"}', 'tool_call'),
            ('{"args":[{"type":"final"}],"type":"tool_calls","calls":[{"name":"a "b""}]}', 'tool_calls'),
            ('Sure.\n{"type":"tool_call","name":"t","args":{"a":"x "y" z"}}', 'tool_call'),
            # Read as JSON would read it, escapes included.
            ('{"type":"tool\\u005fcall","name":"t","args":{"a":"x "y" z"}}', 'tool_call'),
            ('{"type":"fin\\u0061l","content":"cut off', 'final'),
            # A type that is no envelope's is none, whatever is nested under it.
            ('{"type":"task","args":{"type":"tool_call","x":"a "b" c"}}', None),
            # No type of its own to read: the text is searched, and a tool call wins.
            ('{"note":"x "y z","args":{"type":"tool_call"', 'tool_call'),
            # The first tool-call type named wins, also when `final` is named before it.
            (
                '{"note":"x "y z","content":{"type":"final"},"args":{"type":"tool_call"},"calls":{"type":"tool_calls"',
                'tool_call',
            ),
            ('{"content":"abc', None),
            ('no braces at all', None),
        ],
    )
    def test_what_an_unparsed_reply_set_out_to_be(self, text, kind):
        assert reply._attempted_kind(text) == kind

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

        assert 'SAME tool call again' in hint
        assert FINAL_SENTINEL not in hint

    def test_a_tool_call_of_the_wrong_shape_is_asked_for_again_as_a_tool_call(self):
        """Valid JSON, but it names no tool."""
        hint = reply._parse_failure_hint('{"type":"tool_call","name":"","args":{}}')

        assert 'not one of the allowed shapes' in hint
        assert 'Send the tool call again as {"type":"tool_call"' in hint
        assert FINAL_SENTINEL not in hint

    @pytest.mark.parametrize('raw', [PARALLEL_CALLS, '{"type":"tool_calls","calls":[]}'])
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
        'raw', ['```json\n' + BROKEN_TOOL_CALL + '\n```', 'Sure, let me do that.\n' + BROKEN_TOOL_CALL]
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


def test_an_envelope_is_recognised_inside_a_markdown_fence():
    assert reply._looks_like_envelope('```json\n{"type":"tool_call"')
    assert reply._looks_like_envelope('  {"type":"tool_calls"')
    assert not reply._looks_like_envelope('I could not do that.')
    assert not reply._looks_like_envelope('[' + ANSWER_JSON + ']')
    assert not reply._looks_like_envelope('')
    assert not reply._looks_like_envelope(None)


# ---------------------------------------------------------------------------
# One model turn: the retry loop and what it ends on
# ---------------------------------------------------------------------------


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
            # A tool call that never parsed is work that never ran, wherever in the reply it sits.
            ('Sure, let me do that.\n' + BROKEN_TOOL_CALL, 'not valid JSON'),
            (BROKEN_TOOL_CALL + STACKED_FINAL, 'not valid JSON'),
            ('Sure, let me do that.\n' + BROKEN_TOOL_CALL + STACKED_FINAL, 'not valid JSON'),
            # A cut-off answer is not prose to deliver either, with or without a line before it.
            ('Here is the answer:\n' + CUT_OFF_FINAL, 'Unterminated string'),
            # A tool call that lost its "type" is work that never ran, also after a line of prose,
            # and also with a claim about it stacked on.
            ('Here is the result:\n{"name":"crm.create","args":{}}', 'named a tool and its arguments with no "type"'),
            (
                'Here is the result:\n{"name":"crm.create","args":{}}\nFINAL>>> Created.',
                'named a tool and its arguments with no "type"',
            ),
            # A type written out anywhere in the reply counts, also when the first object parses and is no envelope.
            ('Two objects.\n{"note":"first"}\n' + BROKEN_TOOL_CALL, 'not valid JSON'),
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
                'Send the SAME tool call again',
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

    def test_a_marker_after_an_envelope_that_closed_costs_one_call(self):
        ask, feedback = scripted('{"type":"final","content":"old"}\nFINAL>>> {"company":"Acme"}')

        assert answer_of(reply._run_model_turn(ask)) == '{"company":"Acme"}'
        assert len(feedback) == 1

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
