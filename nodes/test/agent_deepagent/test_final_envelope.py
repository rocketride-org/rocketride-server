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
