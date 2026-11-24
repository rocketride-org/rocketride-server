# =============================================================================
# RocketRide Engine
# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Compatibility adapter tests using real LangChain messages and the shared parser."""

from __future__ import annotations

import pytest

from ._real_langchain import LANGCHAIN_SYMBOLS, load_adapter, real_langchain_or_skip


@pytest.fixture(scope='module')
def _parse():
    restore = real_langchain_or_skip()
    try:
        module = load_adapter('agent_langchain/langchain.py', '_langchain_parser_adapter', LANGCHAIN_SYMBOLS)
        yield module._parse_tool_call_envelope
    finally:
        restore()


def _ai_message_class():
    from langchain_core.messages import AIMessage

    return AIMessage


def test_clean_tool_call(_parse):
    raw = '{"type":"tool_call","name":"srv.do_thing","args":{"x":1}}'
    msg = _parse(raw)
    assert msg is not None
    assert isinstance(msg, _ai_message_class())
    assert len(msg.tool_calls) == 1
    tc = msg.tool_calls[0]
    assert tc['name'] == 'srv.do_thing'
    assert tc['args'] == {'x': 1}


def test_clean_final(_parse):
    raw = '{"type":"final","content":"All done."}'
    msg = _parse(raw)
    assert msg is not None
    assert isinstance(msg, _ai_message_class())
    assert msg.content == 'All done.'
    assert msg.tool_calls == []


def test_preamble_before_tool_call(_parse):
    raw = (
        'I\'d be happy to help! Let me list the labels first.\n{"type":"tool_call","name":"gmail.label_list","args":{}}'
    )
    msg = _parse(raw)
    assert msg is not None
    assert msg.tool_calls[0]['name'] == 'gmail.label_list'


def test_preamble_before_final(_parse):
    raw = 'Sure, here is the result:\n{"type":"final","content":"ok"}'
    msg = _parse(raw)
    assert msg is not None
    assert msg.content == 'ok'


def test_markdown_fence_tool_call(_parse):
    raw = '```json\n{"type":"tool_call","name":"t","args":{}}\n```'
    msg = _parse(raw)
    assert msg is not None
    assert msg.tool_calls[0]['name'] == 't'


def test_trailing_text_ignored(_parse):
    raw = '{"type":"final","content":"done"} Here is my explanation.'
    msg = _parse(raw)
    assert msg is not None
    assert msg.content == 'done'


def test_no_json_returns_none(_parse):
    assert _parse('not json at all') is None


def test_empty_string_returns_none(_parse):
    assert _parse('') is None


def test_no_opening_brace_returns_none(_parse):
    assert _parse('["array", "not", "object"]') is None


def test_unknown_type_returns_none(_parse):
    raw = '{"type":"unknown","data":"x"}'
    assert _parse(raw) is None


def test_tool_call_missing_name_returns_none(_parse):
    raw = '{"type":"tool_call","name":"","args":{}}'
    assert _parse(raw) is None


def test_tool_call_args_defaults_to_empty_dict(_parse):
    raw = '{"type":"tool_call","name":"srv.ping"}'
    msg = _parse(raw)
    assert msg is not None
    assert msg.tool_calls[0]['args'] == {}


def test_tool_call_non_dict_args_wrapped_in_input(_parse):
    # Scalar / list args are wrapped as {'input': value} rather than dropped.
    raw = '{"type":"tool_call","name":"srv.echo","args":"hello"}'
    msg = _parse(raw)
    assert msg is not None
    assert msg.tool_calls[0]['args'] == {'input': 'hello'}

    raw = '{"type":"tool_call","name":"srv.echo","args":[1, 2]}'
    msg = _parse(raw)
    assert msg is not None
    assert msg.tool_calls[0]['args'] == {'input': [1, 2]}
