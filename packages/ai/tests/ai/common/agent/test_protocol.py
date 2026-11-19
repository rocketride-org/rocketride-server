# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Unit tests for ``ai.common.agent._internal.protocol``.

``agent_langchain`` and ``agent_deepagent`` read the host LLM's replies through
this module: it parses a reply into a tool call or an answer, retries a reply
that is neither with a hint about what was wrong, and decides what a turn ends
on when the retries run out. Each driver keeps its own prompt.

The cases come from three places:

* ``agent_deepagent``'s envelope tests (the sentinel, salvage of a broken
  `final` envelope, the retry hint), which moved here with the code;
* ``agent_langchain``'s parser tests, which the shared parser has to keep passing;
* issue #3367: a `final` envelope whose content is an object (C), a bare JSON
  object (D) and an envelope cut off mid-answer (I).

Run with::

    pytest packages/ai/tests/ai/common/agent/test_protocol.py -v
"""

from __future__ import annotations

import json
import re
from typing import Any, List, Tuple

import pytest

from ai.common.agent._internal import protocol
from ai.common.agent._internal.protocol import FINAL_SENTINEL, ModelTurn

ANSWER_JSON = '{"company": "Acme", "revenue": 1200}'

# The payload that first showed the bug in agent_deepagent, trimmed to the break:
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


def parse(raw: Any, **kwargs: Any) -> Any:
    return protocol.parse_tool_call_envelope(raw, **kwargs)


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

        assert parse(FINAL_SENTINEL + answer) == ModelTurn(content=answer)

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

    def test_parallel_calls_with_a_final_line_stacked_after_them_still_run(self):
        turn = parse(PARALLEL_CALLS + STACKED_FINAL, parallel=True)

        assert [c['name'] for c in turn.tool_calls] == ['a.one', 'b.two']

    def test_a_broken_tool_call_with_a_final_line_stacked_after_it_is_retried(self):
        """Not delivered as the stacked answer, and the hint asks for the call, not for prose."""
        raw = BROKEN_TOOL_CALL + STACKED_FINAL

        assert parse(raw) is None
        assert protocol.parse_failure_hint(raw).endswith(
            'Send the SAME tool call again as one valid JSON object: repair the JSON, do not answer in prose.'
        )

    def test_a_tool_call_after_a_line_of_prose_keeps_its_stacked_final_out_too(self):
        """Prose before a call never stopped the call from running, and a stacked final does not change that."""
        turn = parse('Sure, creating it now.\n' + TOOL_CALL + STACKED_FINAL)

        assert turn.content == ''
        assert turn.tool_calls[0]['name'] == 'crm.create'
        assert parse('Sure, creating it now.\n' + BROKEN_TOOL_CALL + STACKED_FINAL) is None

    @pytest.mark.parametrize(
        'before', ['{"note": "x"}', '{"type":"final","content":"old"}', 'Thinking about a tool call.']
    )
    def test_other_text_before_the_sentinel_does_not_take_it_away(self, before):
        """Only an attempt at a tool-call envelope before the marker keeps the marker from being read."""
        assert parse(before + '\nFINAL>>> Done.').content == 'Done.'


# ---------------------------------------------------------------------------
# JSON envelopes
# ---------------------------------------------------------------------------


class TestJsonEnvelope:
    def test_a_well_formed_final_is_still_accepted(self):
        assert parse('{"type":"final","content":"All done."}') == ModelTurn(content='All done.')

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


class TestParallelToolCalls:
    def test_accepted_by_a_driver_that_offers_them(self):
        turn = parse(PARALLEL_CALLS, parallel=True)

        assert [(c['name'], c['args']) for c in turn.tool_calls] == [('a.one', {}), ('b.two', {'x': 1})]
        assert len({c['id'] for c in turn.tool_calls}) == 2

    def test_refused_by_a_driver_that_does_not(self):
        """agent_langchain never offered the form, and does not start running calls concurrently because of it."""
        assert parse(PARALLEL_CALLS) is None

    def test_entries_that_name_no_tool_are_skipped(self):
        raw = '{"type":"tool_calls","calls":[{"name":"a.one"},{"name":""},"junk",{"args":{}}]}'

        assert [c['name'] for c in parse(raw, parallel=True).tool_calls] == ['a.one']

    @pytest.mark.parametrize('calls', ['[]', '[{"name":""}]', '"a.one"', 'null'])
    def test_no_usable_call_is_not_a_turn(self, calls):
        assert parse('{"type":"tool_calls","calls":' + calls + '}', parallel=True) is None


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
        assert protocol.salvage_final_content(raw) is None
        assert parse(raw) is None

    def test_a_broken_envelope_with_text_after_it_is_retried_not_salvaged(self):
        """
        The price of telling a cut-off answer from a finished one: in unescaped content, only the end of
        the reply says which `"}` is the envelope's own. The retry is pointed at the sentinel.
        """
        raw = '{"type":"final","content":"No org named "EARTH" was found."} Hope that helps!'

        assert protocol.salvage_final_content(raw) is None
        assert parse(raw) is None
        assert f'send the answer as {FINAL_SENTINEL}' in protocol.parse_failure_hint(raw)

    def test_a_reply_cut_exactly_after_an_inner_closing_still_reads_as_closed(self):
        """The known limit of the same check, pinned so a change to it is a decision and not an accident."""
        assert parse('{"type":"final","content":"Here: {"a":"b"}').content == 'Here: {"a":"b'

    def test_a_malformed_tool_call_is_never_salvaged(self):
        """Rescuing one would turn work the agent meant to do into a sentence saying it was done."""
        assert protocol.salvage_final_content(BROKEN_TOOL_CALL) is None
        assert parse(BROKEN_TOOL_CALL) is None

    def test_ordinary_prose_is_left_alone(self):
        assert protocol.salvage_final_content('I could not do that.') is None

    def test_unescaping_handles_the_escapes_that_were_right(self):
        assert protocol.unescape_json_string_body('a\\nb\\tc\\"d\\\\e\\u00e9') == 'a\nb\tc"d\\eé'

    def test_unescaping_joins_a_surrogate_pair_into_one_character(self):
        """JSON spells an emoji as two escapes. Decoded apart they are lone surrogates, which do not encode."""
        assert protocol.unescape_json_string_body('\\uD83D\\uDE00') == '😀'
        recovered = protocol.unescape_json_string_body('all done \\uD83D\\uDE00, shipping')
        assert recovered == 'all done 😀, shipping'
        assert recovered.encode('utf-8').decode('utf-8') == recovered

    def test_unescaping_leaves_a_lone_high_surrogate_alone(self):
        assert protocol.unescape_json_string_body('\\uD83Dx') == chr(0xD83D) + 'x'

    def test_unescaping_passes_through_what_it_does_not_recognise(self):
        """A lone backslash is far likelier to be a Windows path than a mistake."""
        assert protocol.unescape_json_string_body('C:\\Users\\x') == 'C:\\Users\\x'


# ---------------------------------------------------------------------------
# The retry hint
# ---------------------------------------------------------------------------


class TestRetryHint:
    def test_names_the_break_and_points_a_broken_answer_at_the_sentinel(self):
        hint = protocol.parse_failure_hint(BROKEN_FINAL)

        assert 'not valid JSON' in hint
        assert 'at character' in hint
        # It quotes the text at the break, so the model can see the stray quote.
        assert 'EARTH' in hint
        assert f'send the answer as {FINAL_SENTINEL}' in hint

    @pytest.mark.parametrize('raw', ['', '   ', None])
    def test_an_empty_reply_is_called_empty(self, raw):
        assert protocol.parse_failure_hint(raw) == 'Your last output was empty.'

    def test_a_bare_json_object_is_asked_for_after_the_sentinel(self):
        """#3367 case D. The hint used to say only that the shape was wrong, with no way to answer."""
        hint = protocol.parse_failure_hint(ANSWER_JSON)

        assert 'not one of the allowed shapes' in hint
        assert f'write {FINAL_SENTINEL} followed by the JSON' in hint
        # It may have been a tool call that lost its "type", so that way out is named too.
        assert '{"type":"tool_call","name":"server.tool","args":{...}}' in hint

    @pytest.mark.parametrize('raw', ['{"type":"task","description":"..."}', '[' + ANSWER_JSON + ']'])
    def test_other_valid_json_gets_the_same_two_ways_out(self, raw):
        hint = protocol.parse_failure_hint(raw)

        assert 'not one of the allowed shapes' in hint
        assert FINAL_SENTINEL in hint

    def test_a_broken_tool_call_is_told_to_repair_the_tool_call(self):
        """The hint must not talk the model out of the work: no sentinel for a broken call."""
        hint = protocol.parse_failure_hint(BROKEN_TOOL_CALL)

        assert 'SAME tool call again' in hint
        assert 'do not answer in prose' in hint
        assert FINAL_SENTINEL not in hint

    def test_a_broken_tool_call_stays_one_when_final_is_named_first(self):
        """A "type":"final" inside the arguments, ahead of the envelope's own type, does not turn the call into an answer."""
        raw = '{"args":{"type":"final","note":"a "quoted" word"},"type":"tool_call","name":"crm.create"}'

        hint = protocol.parse_failure_hint(raw)

        assert 'SAME tool call again' in hint
        assert FINAL_SENTINEL not in hint

    @pytest.mark.parametrize(
        'raw, parallel',
        [('{"type":"tool_call","name":"","args":{}}', False), ('{"type":"tool_calls","calls":[]}', True)],
    )
    def test_a_tool_call_of_the_wrong_shape_is_asked_for_again_as_a_tool_call(self, raw, parallel):
        """Valid JSON, but it names no tool."""
        hint = protocol.parse_failure_hint(raw, parallel=parallel)

        assert 'not one of the allowed shapes' in hint
        assert 'Send the tool call again as {"type":"tool_call"' in hint
        assert FINAL_SENTINEL not in hint

    def test_parallel_calls_sent_to_a_driver_without_them_are_asked_for_one_at_a_time(self):
        hint = protocol.parse_failure_hint(PARALLEL_CALLS)

        assert 'Send one tool call per reply, as {"type":"tool_call"' in hint
        assert FINAL_SENTINEL not in hint
        # A driver that takes the form never says so.
        assert 'one tool call per reply' not in protocol.parse_failure_hint(PARALLEL_CALLS, parallel=True)

    @pytest.mark.parametrize('raw', [FINAL_SENTINEL, 'Let me think.\n' + FINAL_SENTINEL + '  '])
    def test_a_sentinel_with_nothing_after_it_is_named_as_that(self, raw):
        """Not as invalid JSON at character 0, which tells a model that did write the marker nothing."""
        assert protocol.parse_failure_hint(raw) == (
            f'Your last output ended at {FINAL_SENTINEL} with no answer after it. Write the answer after {FINAL_SENTINEL}.'
        )

    @pytest.mark.parametrize(
        'raw', ['```json\n' + BROKEN_TOOL_CALL + '\n```', 'Sure, let me do that.\n' + BROKEN_TOOL_CALL]
    )
    def test_the_break_is_found_inside_a_fence_and_after_a_line_of_prose(self, raw):
        """The position is the one in the JSON, where the model can see the stray quote, not character 0."""
        hint = protocol.parse_failure_hint(raw)

        assert hint == protocol.parse_failure_hint(BROKEN_TOOL_CALL)
        assert 'at character 67' in hint
        assert '"content":"a "quoted' in hint

    @pytest.mark.parametrize('raw', [CUT_OFF_FINAL, 'I think the answer is "42", probably.'])
    def test_a_cut_off_answer_and_plain_prose_are_pointed_at_the_sentinel(self, raw):
        assert FINAL_SENTINEL in protocol.parse_failure_hint(raw)


def test_an_envelope_is_recognised_inside_a_markdown_fence():
    assert protocol.looks_like_envelope('```json\n{"type":"tool_call"')
    assert protocol.looks_like_envelope('  {"type":"tool_calls"')
    assert not protocol.looks_like_envelope('I could not do that.')
    assert not protocol.looks_like_envelope('[' + ANSWER_JSON + ']')
    assert not protocol.looks_like_envelope('')
    assert not protocol.looks_like_envelope(None)


# ---------------------------------------------------------------------------
# One model turn: the retry loop and what it ends on
# ---------------------------------------------------------------------------


class TestRunModelTurn:
    def test_a_reply_that_parses_costs_one_call(self):
        ask, feedback = scripted(FINAL_SENTINEL + 'Done.')

        assert protocol.run_model_turn(ask) == ModelTurn(content='Done.')
        assert feedback == ['']

    def test_a_salvaged_answer_costs_one_call(self):
        """#3367 cases A, E and F took three calls and then gave up."""
        ask, feedback = scripted('{"type":"final","content":"' + ANSWER_JSON + '"}')

        assert protocol.run_model_turn(ask).content == ANSWER_JSON
        assert len(feedback) == 1

    def test_the_second_attempt_can_follow_the_first_hint(self):
        """A broken tool call, the hint, the same call repaired: the turn ends in the call, in two attempts."""
        ask, feedback = scripted(BROKEN_TOOL_CALL, REPAIRED_TOOL_CALL)

        turn = protocol.run_model_turn(ask)

        assert turn.tool_calls[0]['name'] == 'crm.note_create'
        assert turn.tool_calls[0]['args'] == {'content': 'a "quoted" note'}
        assert feedback == ['', '\n\nsystem: ' + protocol.parse_failure_hint(BROKEN_TOOL_CALL)]
        assert FINAL_SENTINEL not in feedback[1]

    def test_a_bare_json_answer_recovers_once_the_hint_is_followed(self):
        """#3367 case D with a model that reads the hint: the JSON arrives, after the sentinel, on attempt two."""
        ask, feedback = scripted(ANSWER_JSON, FINAL_SENTINEL + ANSWER_JSON)

        assert protocol.run_model_turn(ask).content == ANSWER_JSON
        assert len(feedback) == 2
        assert f'write {FINAL_SENTINEL} followed by the JSON' in feedback[1]

    def test_each_failed_attempt_adds_its_hint(self):
        ask, feedback = scripted('', 'Some prose.', FINAL_SENTINEL + 'Done.')

        assert protocol.run_model_turn(ask).content == 'Done.'
        assert feedback[1] == '\n\nsystem: Your last output was empty.'
        assert feedback[2] == feedback[1] + '\n\nsystem: ' + protocol.parse_failure_hint('Some prose.')

    def test_a_reply_is_read_without_its_surrounding_whitespace(self):
        ask, _ = scripted('\n  {"type":"final","content":"ok"}  \n')

        assert protocol.run_model_turn(ask).content == 'ok'

    @pytest.mark.parametrize(
        'reply, said',
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
            # The marker alone is protocol text, not an answer.
            (FINAL_SENTINEL, f'ended at {FINAL_SENTINEL} with no answer after it'),
            ('Let me think.\n' + FINAL_SENTINEL, f'ended at {FINAL_SENTINEL} with no answer after it'),
        ],
    )
    def test_a_turn_with_nothing_to_deliver_fails(self, reply, said):
        """
        The run then ends as an error. A broken tool call (work that never ran), a bare object, a
        cut-off answer and an empty reply are not answers, and neither is a sentence about giving up.
        """
        ask, feedback = scripted(reply)

        with pytest.raises(ValueError, match='No valid tool call or final answer after 3 attempts') as failure:
            protocol.run_model_turn(ask)

        message = str(failure.value)
        assert said in message
        assert len(feedback) == protocol.MAX_ATTEMPTS == 3
        # The error is read by a person, or by a parent agent's model as a tool result. It says what
        # was wrong and carries none of the instructions written for this model.
        assert 'The last reply ' in message
        for instruction in ('Your last output', 'Send ', 'Do not retype', 'To call a tool', 'Write the answer'):
            assert instruction not in message

    def test_the_last_reply_decides_what_an_unparsed_turn_ends_on(self):
        """Readable prose on the earlier attempts does not rescue a turn whose last reply is empty."""
        ask, _ = scripted('Some prose.', 'Some prose.', '')

        with pytest.raises(ValueError, match='The last reply was empty.'):
            protocol.run_model_turn(ask)

    def test_a_stacked_final_does_not_replace_the_tool_call_it_follows(self):
        ask, feedback = scripted(TOOL_CALL + STACKED_FINAL)

        assert protocol.run_model_turn(ask).tool_calls[0]['name'] == 'crm.create'
        assert len(feedback) == 1

    @pytest.mark.parametrize('reply', ['I could not find that organization.', '[' + ANSWER_JSON + ']'])
    def test_prose_that_skipped_the_sentinel_is_still_the_answer(self, reply):
        """#3367 cases G and H. The model said something readable, so it is delivered once the retries are spent."""
        ask, feedback = scripted(reply)

        assert protocol.run_model_turn(ask) == ModelTurn(content=reply)
        assert len(feedback) == 3

    def test_the_parallel_form_follows_the_driver(self):
        ask, _ = scripted(PARALLEL_CALLS)
        assert [c['name'] for c in protocol.run_model_turn(ask, parallel=True).tool_calls] == ['a.one', 'b.two']

        ask, feedback = scripted(PARALLEL_CALLS)
        with pytest.raises(ValueError, match='not one of the allowed shapes'):
            protocol.run_model_turn(ask)
        assert len(feedback) == 3
