# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Unit tests for ``ai.common.utils.agent_tools``:

* ``normalize_bound_tools`` — flatten LangChain tools into descriptor dicts.
* ``langchain_messages_to_transcript`` — render a LangChain message list as
  a multi-line transcript.

Tests use **mock** message and tool classes rather than importing LangChain.
This keeps the unit tests fast and lets them run in environments that have
not installed langchain_core. The production code imports langchain_core
lazily inside ``langchain_messages_to_transcript``; when the import fails,
the function substitutes a sentinel class so the subsequent ``isinstance``
checks correctly return False (the message body still falls through to the
bare-user branch).

Run with::

    pytest packages/ai/tests/ai/common/utils/test_agent_tools.py -v
"""

from __future__ import annotations

import pytest

from ai.common.utils import (
    langchain_messages_to_transcript,
    normalize_bound_tools,
)


# ---------------------------------------------------------------------------
# Helpers — mock LangChain tool / message shapes
# ---------------------------------------------------------------------------


class _MockTool:
    """Mock LangChain BaseTool with name, description, optional args_schema."""

    def __init__(self, name='t', description='d', args_schema=None, rr_input_schema=None):
        self.name = name
        self.description = description
        if args_schema is not None:
            self.args_schema = args_schema
        if rr_input_schema is not None:
            self._rr_input_schema = rr_input_schema


class _PydanticV2Schema:
    """Mock pydantic v2 model — exposes model_json_schema()."""

    def __init__(self, schema: dict):
        self._schema = schema

    def model_json_schema(self):
        return self._schema


class _PydanticV1Schema:
    """Mock pydantic v1 model — exposes schema() but not model_json_schema()."""

    def __init__(self, schema: dict):
        self._schema = schema

    def schema(self):
        return self._schema


# ---------------------------------------------------------------------------
# normalize_bound_tools
# ---------------------------------------------------------------------------


class TestNormalizeBoundTools:
    def test_none_returns_empty(self):
        assert normalize_bound_tools(None) == []

    def test_empty_list_returns_empty(self):
        assert normalize_bound_tools([]) == []

    def test_single_tool_wrapped_in_list(self):
        # Bare tool (not a list) — function wraps it itself.
        t = _MockTool(name='one', description='just one')
        out = normalize_bound_tools(t)
        assert len(out) == 1
        assert out[0]['name'] == 'one'
        assert out[0]['description'] == 'just one'

    def test_list_of_tools(self):
        a = _MockTool(name='a', description='alpha')
        b = _MockTool(name='b', description='beta')
        out = normalize_bound_tools([a, b])
        assert [e['name'] for e in out] == ['a', 'b']
        assert [e['description'] for e in out] == ['alpha', 'beta']

    def test_tool_without_schema_has_empty_args_schema(self):
        out = normalize_bound_tools([_MockTool()])
        assert out[0]['args_schema'] == ''

    def test_pydantic_v2_schema_extracted(self):
        schema = {'type': 'object', 'properties': {'q': {'type': 'string'}}}
        tool = _MockTool(args_schema=_PydanticV2Schema(schema))
        out = normalize_bound_tools([tool])
        assert out[0]['args_schema'] == schema

    def test_pydantic_v1_schema_extracted(self):
        schema = {'type': 'object', 'properties': {'n': {'type': 'integer'}}}
        tool = _MockTool(args_schema=_PydanticV1Schema(schema))
        out = normalize_bound_tools([tool])
        assert out[0]['args_schema'] == schema

    def test_schema_that_raises_falls_back_to_string(self):
        class _Bad:
            def model_json_schema(self):
                raise RuntimeError('boom')

            def schema(self):
                raise RuntimeError('boom')

            def __str__(self):
                return '<Bad>'

        out = normalize_bound_tools([_MockTool(args_schema=_Bad())])
        # When both schema methods raise, fall back to str(schema).
        assert out[0]['args_schema'] == '<Bad>'

    def test_rr_input_schema_included_when_dict(self):
        input_schema = {'type': 'object', 'properties': {'x': {'type': 'integer'}}}
        tool = _MockTool(rr_input_schema=input_schema)
        out = normalize_bound_tools([tool])
        assert out[0]['input_schema'] == input_schema

    def test_rr_input_schema_skipped_when_not_dict(self):
        # Non-dict _rr_input_schema is silently ignored — keeps the output
        # shape predictable when a tool attaches a malformed override.
        tool = _MockTool(rr_input_schema='not a dict')
        out = normalize_bound_tools([tool])
        assert 'input_schema' not in out[0]

    def test_missing_attrs_handled(self):
        # Tool with no name / description attributes at all.
        class _Bare:
            pass

        out = normalize_bound_tools([_Bare()])
        assert out[0]['name'] == ''
        assert out[0]['description'] == ''


# ---------------------------------------------------------------------------
# langchain_messages_to_transcript
# ---------------------------------------------------------------------------
#
# The function imports langchain_core.messages lazily and falls back to a
# unique sentinel class when the import fails, so the isinstance checks
# correctly return False and every message renders as 'user'. In the test
# environment we cannot guarantee langchain_core is installed, so we
# instead inject our own classes named exactly like the LangChain ones
# via monkeypatch — this exercises the role-detection branches without
# needing the real LangChain package.


@pytest.fixture
def lc_messages(monkeypatch):
    """Inject mock LangChain message classes into langchain_core.messages."""
    import sys
    import types

    class SystemMessage:
        def __init__(self, content=''):
            self.content = content

    class HumanMessage:
        def __init__(self, content=''):
            self.content = content

    class AIMessage:
        def __init__(self, content='', tool_calls=None):
            self.content = content
            if tool_calls is not None:
                self.tool_calls = tool_calls

    class ToolMessage:
        def __init__(self, content='', name='', tool_call_id=''):
            self.content = content
            self.name = name
            self.tool_call_id = tool_call_id

    mod = types.ModuleType('langchain_core.messages')
    mod.SystemMessage = SystemMessage
    mod.HumanMessage = HumanMessage
    mod.AIMessage = AIMessage
    mod.ToolMessage = ToolMessage

    parent = types.ModuleType('langchain_core')
    parent.messages = mod

    monkeypatch.setitem(sys.modules, 'langchain_core', parent)
    monkeypatch.setitem(sys.modules, 'langchain_core.messages', mod)
    return mod


class TestLangchainMessagesToTranscript:
    def test_none_returns_empty(self):
        assert langchain_messages_to_transcript(None) == ''

    def test_string_returns_as_is(self):
        assert langchain_messages_to_transcript('already a string') == 'already a string'

    def test_dict_returns_json(self):
        out = langchain_messages_to_transcript({'a': 1, 'b': 'x'})
        # json dump ordering is insertion-ordered as of Python 3.7+.
        assert out == '{"a": 1, "b": "x"}'

    def test_non_list_non_dict_non_str_falls_back_to_str(self):
        # An integer for instance — best-effort str().
        assert langchain_messages_to_transcript(42) == '42'

    def test_empty_list_returns_empty(self):
        assert langchain_messages_to_transcript([]) == ''

    def test_single_human_message(self, lc_messages):
        msg = lc_messages.HumanMessage(content='hello')
        out = langchain_messages_to_transcript([msg])
        assert out == 'user: hello'

    def test_mixed_roles_in_order(self, lc_messages):
        messages = [
            lc_messages.SystemMessage(content='you are helpful'),
            lc_messages.HumanMessage(content='hi'),
            lc_messages.AIMessage(content='hello back'),
        ]
        out = langchain_messages_to_transcript(messages)
        assert out == 'system: you are helpful\nuser: hi\nassistant: hello back'

    def test_tool_message_with_name(self, lc_messages):
        msg = lc_messages.ToolMessage(content='result', name='search')
        out = langchain_messages_to_transcript([msg])
        assert out == 'tool[search]: result'

    def test_tool_message_without_name(self, lc_messages):
        msg = lc_messages.ToolMessage(content='result', name='')
        out = langchain_messages_to_transcript([msg])
        assert out == 'tool: result'

    def test_ai_message_with_tool_calls_renders_envelope(self, lc_messages):
        msg = lc_messages.AIMessage(
            content='thinking...',
            tool_calls=[{'name': 'search', 'args': {'q': 'cats'}}],
        )
        out = langchain_messages_to_transcript([msg])
        assert out.startswith('assistant: thinking...')
        assert '"type": "tool_call"' in out
        assert '"name": "search"' in out
        assert '"q": "cats"' in out

    def test_ai_message_with_empty_tool_calls(self, lc_messages):
        msg = lc_messages.AIMessage(content='just text', tool_calls=[])
        out = langchain_messages_to_transcript([msg])
        assert out == 'assistant: just text'

    def test_non_message_object_in_list_handled(self, lc_messages):
        # Random object without content attr — falls into the bare-user
        # branch and renders as 'user: <safe_str(m)>'.
        class _Random:
            def __str__(self):
                return '<random>'

        out = langchain_messages_to_transcript([_Random()])
        # When the object has no .content, safe_str() of getattr returns ''
        # and we get 'user: '. The exact rendering is not critical — the
        # point is the function does NOT crash on non-message objects.
        assert out.startswith('user:')

    def test_strip_trims_trailing_whitespace(self, lc_messages):
        # The function ends with ``.strip()`` so trailing newlines are
        # removed.
        msg = lc_messages.HumanMessage(content='x')
        out = langchain_messages_to_transcript([msg])
        assert not out.endswith('\n')

    # -- parallel tool-call identity (regression) ---------------------------
    #
    # On every turn the transcript is replayed to the LLM as context. When an
    # assistant turn issued *parallel* tool calls, the prior implementation
    # flattened them into separate single-call lines and dropped both the
    # per-call ``id`` and the ``ToolMessage.tool_call_id``, so the replayed
    # turn lost the call->result pairing — the model could mis-attribute
    # results, especially when several parallel calls hit the *same* tool
    # (e.g. ``task`` for subagent fan-out). These tests pin the identity.

    def test_single_tool_call_round_trips_with_id(self, lc_messages):
        """A lone tool call renders as the singular envelope and carries its id."""
        messages = [
            lc_messages.AIMessage(
                content='',
                tool_calls=[{'id': 'call_solo', 'name': 'search', 'args': {'q': 'x'}}],
            ),
            lc_messages.ToolMessage(content='hit', name='search', tool_call_id='call_solo'),
        ]
        out = langchain_messages_to_transcript(messages)

        assert '"type": "tool_call"' in out
        assert '"id": "call_solo"' in out
        # The result line is pinned to the same id.
        assert 'tool[search#call_solo]: hit' in out

    def test_parallel_calls_preserve_grouping_and_per_call_identity(self, lc_messages):
        """Two parallel calls to the SAME tool keep distinct ids on call and result."""
        messages = [
            lc_messages.HumanMessage(content='do both'),
            lc_messages.AIMessage(
                content='',
                tool_calls=[
                    {'id': 'call_a', 'name': 'task', 'args': {'description': 'A'}},
                    {'id': 'call_b', 'name': 'task', 'args': {'description': 'B'}},
                ],
            ),
            lc_messages.ToolMessage(content='result A', name='task', tool_call_id='call_a'),
            lc_messages.ToolMessage(content='result B', name='task', tool_call_id='call_b'),
        ]
        out = langchain_messages_to_transcript(messages)

        # Grouping preserved: ONE plural envelope, not two flattened single-call lines.
        assert '"type": "tool_calls"' in out
        assert out.count('"type": "tool_call"') == 0

        # Both call ids survive on the assistant side.
        assert '"id": "call_a"' in out
        assert '"id": "call_b"' in out

        # Each result is explicitly pinned to the call that produced it — this is
        # the pairing that was lost before the fix.
        assert 'tool[task#call_a]: result A' in out
        assert 'tool[task#call_b]: result B' in out

    def test_missing_tool_call_id_degrades_gracefully(self, lc_messages):
        """A ToolMessage with no tool_call_id still renders by name (no crash, no '#')."""
        msg = lc_messages.ToolMessage(content='ok', name='search', tool_call_id='')
        out = langchain_messages_to_transcript([msg])
        assert out == 'tool[search]: ok'
