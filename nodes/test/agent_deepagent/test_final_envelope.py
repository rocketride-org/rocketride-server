# =============================================================================
# RocketRide Engine
# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Network-free unit tests for the deepagent's final-answer path.

Bug: a chat answer was delivered to the user as the raw protocol envelope —

    {"type":"final","content":"Here's what I found:\\n\\n| Contact | ...

— instead of the table it contained. The manager had chosen the correct shape;
its content simply said ``no org named "EARTH" found`` and those inner quotes
were never escaped as ``\\"``. That makes the envelope invalid JSON (it breaks
at the first stray quote), so `_extract_first_json_object` returned None on both
its paths, `_parse_tool_call_envelope` returned None three times, and the retry
loop's last line handed the unparsed string over as the answer.

The turn cost 73 LLM calls — the most of any that day — because the retry nudge
said only "Your last output was invalid", which the model could not act on: it
rewrote the same answer and made the same mistake each time.

Three fixes, tested here:
  (a) final answers use the ``FINAL>>>`` sentinel, which has nothing to escape,
  (b) an unparseable but unmistakable `final` envelope is salvaged, not dumped,
  (c) the retry nudge names the character that broke and quotes the text there.

The harness follows extract_facts/test_extract_facts.py: rocketlib, ai.common.*
and langchain_core are stubbed, and deepagent.py is loaded from source via
spec_from_file_location. No engine and no network.
"""

from __future__ import annotations

import importlib.util
import json
import os
import sys
import types

import pytest


_HERE = os.path.dirname(os.path.abspath(__file__))
_NODE_DIR = os.path.join(_HERE, '..', '..', 'src', 'nodes', 'agent_deepagent')


# ---------------------------------------------------------------------------
# Loader — stub the engine and langchain collaborators, then load from source.
# ---------------------------------------------------------------------------


class FakeAIMessage:
    """Stands in for langchain_core.messages.AIMessage."""

    def __init__(self, content='', tool_calls=None):
        self.content = content
        self.tool_calls = tool_calls or []


def _install_stubs():
    """
    Install the stubs and return (module, restore).

    The stubs stay in `sys.modules` for the whole test module rather than being
    torn down after the import: `_parse_tool_call_envelope` imports AIMessage
    LAZILY, inside the call, and swallows the failure by returning None — so a
    stub that is only present at load time makes every parse look like a refusal.
    """
    saved = {}
    stubs = {
        'rocketlib': types.ModuleType('rocketlib'),
        'ai': types.ModuleType('ai'),
        'ai.common': types.ModuleType('ai.common'),
        'ai.common.agent': types.ModuleType('ai.common.agent'),
        'ai.common.agent.types': types.ModuleType('ai.common.agent.types'),
        'ai.common.schema': types.ModuleType('ai.common.schema'),
        'ai.common.utils': types.ModuleType('ai.common.utils'),
        'langchain_core': types.ModuleType('langchain_core'),
        'langchain_core.messages': types.ModuleType('langchain_core.messages'),
    }

    stubs['rocketlib'].ToolDescriptor = object
    stubs['rocketlib'].error = lambda *a, **kw: None
    stubs['ai.common.agent'].AgentBase = object
    stubs['ai.common.agent'].AgentContext = object
    stubs['ai.common.agent.types'].AgentRunResult = object
    stubs['ai.common.schema'].Question = object
    stubs['ai.common.utils'].langchain_messages_to_transcript = lambda m: ''
    stubs['ai.common.utils'].normalize_bound_tools = lambda t: t
    stubs['ai.common.utils'].safe_str = lambda v: '' if v is None else str(v)
    stubs['langchain_core.messages'].AIMessage = FakeAIMessage

    for name, stub in stubs.items():
        saved[name] = sys.modules.get(name)
        sys.modules[name] = stub

    def restore():
        for name in stubs:
            if saved[name] is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = saved[name]
        sys.modules.pop('deepagent_under_test', None)

    try:
        spec = importlib.util.spec_from_file_location('deepagent_under_test', os.path.join(_NODE_DIR, 'deepagent.py'))
        mod = importlib.util.module_from_spec(spec)
        sys.modules['deepagent_under_test'] = mod
        spec.loader.exec_module(mod)
    except Exception:
        restore()
        raise
    return mod, restore


@pytest.fixture(scope='module')
def dp():
    mod, restore = _install_stubs()
    yield mod
    restore()


# ---------------------------------------------------------------------------
# The exact payload that shipped the bug (run 3375), trimmed to the break.
# ---------------------------------------------------------------------------

BROKEN = (
    '{"type":"final","content":"Here\'s what I found:\\n\\n'
    '| Contact | Person in Pipedrive? |\\n'
    '| Richard Vasquez | **Not found**; no org named "EARTH" found |\\n\\n'
    'Would you like me to create person records?"}'
)


def test_the_payload_that_shipped_the_bug_really_is_invalid_json():
    """Guards the premise. If this ever parses, the rest of the file is theatre."""
    with pytest.raises(json.JSONDecodeError):
        json.loads(BROKEN)


# ---------------------------------------------------------------------------
# (a) The sentinel
# ---------------------------------------------------------------------------


def test_a_sentinel_answer_needs_no_escaping(dp):
    """
    THE FIX FOR THE WHOLE CLASS OF BUG.

    The content that broke the envelope is delivered verbatim here, quotes and
    all, because after the marker there is no JSON left to invalidate.
    """
    answer = 'Here is a table with "EARTH" in it, and a \\ backslash, and {braces}.'
    msg = dp._parse_tool_call_envelope(dp.FINAL_SENTINEL + answer)

    assert msg is not None
    assert msg.content == answer


def test_the_sentinel_wins_over_a_json_object_after_it(dp):
    """
    An answer may legitimately CONTAIN an envelope — someone asking what went
    wrong yesterday gets one quoted back at them. The sentinel is checked before
    any JSON is looked for, so the braces inside it stay part of the answer.
    """
    answer = 'The bad output was {"type":"final","content":"..."} — that is the bug.'
    msg = dp._parse_tool_call_envelope(dp.FINAL_SENTINEL + answer)

    assert msg.content == answer


def test_a_tool_call_that_quotes_the_sentinel_is_still_a_tool_call(dp):
    """
    THE MIRROR OF THE TEST ABOVE, and the one an unanchored `find` fails.

    Protocol text travels: a delegation carrying instructions, a note whose body
    quotes the format, a transcript replayed into a prompt. Matching the
    sentinel anywhere in the output turns a well-formed tool call that merely
    MENTIONS it into a final answer — the tool never runs, and the person reads
    a fragment of JSON. The sentinel the prompt asks for opens a line; one
    buried mid-line inside a single-line envelope is quoted text.
    """
    raw = (
        '{"type":"tool_call","name":"crm.note_create",'
        '"args":{"content":"Reply with FINAL>>> when the booking is confirmed"}}'
    )

    msg = dp._parse_tool_call_envelope(raw)

    assert msg.tool_calls, 'the tool call was swallowed by the sentinel'
    assert msg.tool_calls[0]['name'] == 'crm.note_create'
    assert 'FINAL>>>' in msg.tool_calls[0]['args']['content']


def test_a_sentinel_after_leading_prose_still_opens_its_own_line(dp):
    """Anchoring is to a line, not to the start of the output."""
    msg = dp._parse_tool_call_envelope('Thinking out loud first.\n\nFINAL>>> Here it is.')

    assert msg.content == 'Here it is.'


def test_an_answer_keeps_the_whitespace_that_means_something(dp):
    """
    DELIVERED AS WRITTEN, which is the whole promise of the sentinel. Four
    leading spaces are what make the line a markdown code block; stripping them
    turned an answer about code into a paragraph. Only the one separator between
    the marker and the answer comes off.
    """
    msg = dp._parse_tool_call_envelope(dp.FINAL_SENTINEL + '\n    indented = "code"')

    assert msg.content == '    indented = "code"'


def test_the_separator_after_the_sentinel_is_removed(dp):
    """One newline, or one same-line space — never more."""
    assert dp._parse_tool_call_envelope(dp.FINAL_SENTINEL + ' Here it is.').content == 'Here it is.'
    assert dp._parse_tool_call_envelope(dp.FINAL_SENTINEL + '\nHere it is.').content == 'Here it is.'
    assert dp._parse_tool_call_envelope(dp.FINAL_SENTINEL + '\r\nHere it is.').content == 'Here it is.'
    # A blank first line is the answer's own, so it stays.
    assert dp._parse_tool_call_envelope(dp.FINAL_SENTINEL + '\n\nHere it is.').content == '\nHere it is.'


def test_an_empty_sentinel_answer_is_not_an_answer(dp):
    """
    A model that writes the marker and stops has said nothing. Returning it
    would hand `_generate` an empty success and end the turn silently; None
    sends it back through the retry loop instead.
    """
    assert dp._parse_tool_call_envelope(dp.FINAL_SENTINEL) is None
    assert dp._parse_tool_call_envelope(dp.FINAL_SENTINEL + '   \n  ') is None


def test_the_protocol_prompt_asks_for_the_sentinel_not_json(dp):
    """The prompt is the only place the model learns the shape."""
    prompt = dp._tool_call_protocol_prompt([])

    assert dp.FINAL_SENTINEL in prompt
    # Tool calls are still JSON — that half was never the problem.
    assert '{"type":"tool_call"' in prompt
    assert 'do NOT use JSON' in prompt


# ---------------------------------------------------------------------------
# (b) Salvage
# ---------------------------------------------------------------------------


def test_an_unparseable_final_envelope_is_salvaged(dp):
    """The reported bug: the answer comes back, not the envelope."""
    msg = dp._parse_tool_call_envelope(BROKEN)

    assert msg is not None
    assert not msg.content.startswith('{"type"'), 'the protocol was handed to the user'
    assert msg.content.startswith("Here's what I found:")
    # The escapes that WERE correct are still honoured...
    assert '\n\n| Contact |' in msg.content
    # ...and the stray quote that broke it survives as itself.
    assert 'no org named "EARTH" found' in msg.content


def test_salvage_refuses_a_malformed_tool_call(dp):
    """
    A BROKEN TOOL CALL MUST NEVER BECOME AN ANSWER.

    Rescuing one would turn work the crew intended to do into a sentence saying
    it was done — the worst possible failure for a thing that writes to a CRM.
    Only an explicit `"type":"final"` is salvageable.
    """
    broken_call = '{"type":"tool_call","name":"pipedrive.create","args":{"name":"a "quoted" org"}}'

    assert dp._salvage_final_content(broken_call) is None
    assert dp._parse_tool_call_envelope(broken_call) is None


def test_salvage_leaves_ordinary_prose_alone(dp):
    """Not every unparseable output is an envelope."""
    assert dp._salvage_final_content('I could not do that.') is None


def test_unescaping_handles_the_escapes_that_were_right(dp):
    """Newlines, tabs, quotes, backslashes and \\u — the ones json.loads would have."""
    body = 'a\\nb\\tc\\"d\\\\e\\u00e9'

    assert dp._unescape_json_string_body(body) == 'a\nb\tc"d\\eé'


def test_unescaping_joins_a_surrogate_pair_into_one_character(dp):
    """
    JSON HAS NO OTHER WAY TO WRITE AN EMOJI: an astral character is spelled as
    two escapes, and decoded apart they are two lone surrogates — not characters,
    and `str.encode` refuses them, so the salvaged answer would raise on its way
    out rather than read as what somebody typed.
    """
    assert dp._unescape_json_string_body('\\uD83D\\uDE00') == '😀'
    # Still one character, with prose either side, and it survives an encode.
    recovered = dp._unescape_json_string_body('all done \\uD83D\\uDE00 — shipping')
    assert recovered == 'all done 😀 — shipping'
    assert recovered.encode('utf-8').decode('utf-8') == recovered


def test_unescaping_leaves_a_lone_high_surrogate_alone(dp):
    """Only a real pair is joined; a half-written escape keeps the old behaviour."""
    assert dp._unescape_json_string_body('\\uD83Dx') == chr(0xD83D) + 'x'


def test_unescaping_passes_through_what_it_does_not_recognise(dp):
    """
    A lone backslash is far likelier to be part of the prose — a Windows path,
    a LaTeX fragment — than a mistake worth deleting.
    """
    assert dp._unescape_json_string_body('C:\\Users\\x') == 'C:\\Users\\x'


# ---------------------------------------------------------------------------
# (c) The retry hint
# ---------------------------------------------------------------------------


def test_the_retry_hint_names_the_break(dp):
    """
    "Your last output was invalid" is true and unusable: the model cannot see
    which character broke it, so it retypes the same answer three times. The hint
    has to carry the position and the text around it.
    """
    hint = dp._parse_failure_hint(BROKEN)

    assert 'not valid JSON' in hint
    assert 'character' in hint
    # It quotes the text at the break, so the model can see the stray quote.
    assert 'EARTH' in hint
    # And points at the shape that cannot fail instead of asking for JSON again.
    assert dp.FINAL_SENTINEL in hint


def test_the_retry_hint_handles_an_empty_output(dp):
    assert 'empty' in dp._parse_failure_hint('').lower()


def test_the_retry_hint_reports_valid_json_of_the_wrong_shape(dp):
    """Parsed fine, but `type` was not one of the three."""
    hint = dp._parse_failure_hint('{"type":"task","description":"..."}')

    assert 'not one of the allowed shapes' in hint


# ---------------------------------------------------------------------------
# (d) Out of attempts
# ---------------------------------------------------------------------------


class _FakeChatGeneration:
    def __init__(self, message):
        self.message = message


class _FakeChatResult:
    def __init__(self, generations):
        self.generations = generations


@pytest.fixture
def llm_answering(dp, monkeypatch):
    """
    Build the deepagent's chat model around a host LLM that always says `raw`.

    Returns a builder yielding (model, prompts) — `prompts` records every call.
    """
    language_models = types.ModuleType('langchain_core.language_models')
    language_models.BaseChatModel = type('BaseChatModel', (), {})
    message_utils = types.ModuleType('langchain_core.messages.utils')
    message_utils.count_tokens_approximately = lambda messages: 0
    outputs = types.ModuleType('langchain_core.outputs')
    outputs.ChatGeneration = _FakeChatGeneration
    outputs.ChatResult = _FakeChatResult
    monkeypatch.setitem(sys.modules, 'langchain_core.language_models', language_models)
    monkeypatch.setitem(sys.modules, 'langchain_core.messages.utils', message_utils)
    monkeypatch.setitem(sys.modules, 'langchain_core.outputs', outputs)
    monkeypatch.setattr(sys.modules['langchain_core.messages'], 'HumanMessage', FakeAIMessage, raising=False)

    def build(raw):
        """`raw` is one answer repeated, or a list answered in order (the last repeats)."""
        replies = raw if isinstance(raw, list) else [raw]
        prompts = []

        def call_llm(context, prompt, **kwargs):
            prompts.append(prompt)
            return replies[min(len(prompts) - 1, len(replies) - 1)]

        return dp._build_deepagent_llm(types.SimpleNamespace(call_llm=call_llm), None), prompts

    return build


def test_a_tool_call_that_never_parses_fails_the_run(llm_answering):
    """
    THE RETRY LOOP'S LAST LINE MUST NOT DELIVER THE PROTOCOL EITHER.

    Salvage refuses a broken tool call; handing the raw string over after the
    third failure would undo that refusal — the tool never runs, and the person
    reads the JSON as if it were the answer. The run fails instead.
    """
    broken_call = '{"type":"tool_call","name":"pipedrive.create","args":{"name":"a "quoted" org"}}'
    model, prompts = llm_answering(broken_call)

    with pytest.raises(ValueError, match='No valid tool call or final answer'):
        model._generate([])
    assert len(prompts) == 3


def test_prose_that_skipped_the_sentinel_is_still_the_answer(llm_answering):
    """A model that answered in plain words without the marker said something readable."""
    model, prompts = llm_answering('I could not find that organization.')

    result = model._generate([])

    assert result.generations[0].message.content == 'I could not find that organization.'
    assert len(prompts) == 3


def test_a_broken_tool_call_is_told_to_repair_the_tool_call(dp):
    """
    THE HINT MUST NOT TALK THE MODEL OUT OF THE WORK.

    A malformed `tool_call` is a job that has not been done. Answering `FINAL>>>`
    instead would hand back a sentence about a record nobody wrote, so the nudge
    for a broken CALL asks for the call again, and only a broken ANSWER is
    pointed at the sentinel.
    """
    hint = dp._parse_failure_hint('{"type":"tool_call","name":"crm.create","args":{"name":"a "quoted" org"}}')

    assert 'tool call' in hint
    assert 'do not answer in prose' in hint.lower()
    assert dp.FINAL_SENTINEL not in hint


def test_a_broken_final_envelope_is_still_pointed_at_the_sentinel(dp):
    hint = dp._parse_failure_hint(BROKEN)

    assert dp.FINAL_SENTINEL in hint


def test_prose_that_never_reached_json_is_pointed_at_the_sentinel(dp):
    hint = dp._parse_failure_hint('I think the answer is "42", probably.')

    assert dp.FINAL_SENTINEL in hint


def test_the_second_attempt_can_follow_the_first_hint(dp, llm_answering):
    """
    THE RETRY LOOP HAS TO BE ABLE TO RECOVER, not just to fail tidily.

    The model answers with a broken tool call, reads the hint, and sends the
    same call repaired. The turn then ends in the tool call it was always meant
    to be — in two LLM calls, not three.
    """
    broken = '{"type":"tool_call","name":"crm.note_create","args":{"content":"a "quoted" note"}}'
    repaired = '{"type":"tool_call","name":"crm.note_create","args":{"content":"a \\"quoted\\" note"}}'
    model, prompts = llm_answering([broken, repaired])

    result = model._generate([])

    message = result.generations[0].message
    assert message.tool_calls[0]['name'] == 'crm.note_create'
    assert message.tool_calls[0]['args']['content'] == 'a "quoted" note'
    assert len(prompts) == 2
    # The second prompt is the first plus the hint, and the hint asked for the
    # CALL again rather than pointing at the sentinel.
    hint = prompts[1][len(prompts[0]) :]
    assert 'do not answer in prose' in hint.lower()
    assert dp.FINAL_SENTINEL not in hint


def test_an_envelope_is_recognised_inside_a_markdown_fence(dp):
    assert dp._looks_like_envelope('```json\n{"type":"tool_call"')
    assert dp._looks_like_envelope('  {"type":"tool_calls"')
    assert not dp._looks_like_envelope('I could not do that.')
    assert not dp._looks_like_envelope('')


# ---------------------------------------------------------------------------
# The shapes that already worked must keep working.
# ---------------------------------------------------------------------------


def test_a_well_formed_json_final_is_still_accepted(dp):
    """Models trained on the old prompt still emit it, and archives contain it."""
    msg = dp._parse_tool_call_envelope('{"type":"final","content":"All done."}')

    assert msg.content == 'All done.'


def test_a_tool_call_still_parses(dp):
    msg = dp._parse_tool_call_envelope('{"type":"tool_call","name":"srv.tool","args":{"a":1}}')

    assert msg.tool_calls[0]['name'] == 'srv.tool'
    assert msg.tool_calls[0]['args'] == {'a': 1}


def test_parallel_tool_calls_still_parse(dp):
    msg = dp._parse_tool_call_envelope(
        '{"type":"tool_calls","calls":[{"name":"a.one","args":{}},{"name":"b.two","args":{}}]}'
    )

    assert [c['name'] for c in msg.tool_calls] == ['a.one', 'b.two']
